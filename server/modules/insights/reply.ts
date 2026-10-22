/**
 * Reads a vendor's free-text reply (pasted from e-mail or WhatsApp) for a delivery date and a delay reason.
 * Rule-based: explicit patterns only. It proposes; the buyer confirms and picks the reason code before anything is
 * recorded. It never guesses a date from vague words ("soon", "shortly").
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** Exact month names or three-letter abbreviations only, so words like "marked" or "decimal" are not read as dates. */
const monthIndex = (w: string) => {
  const x = w.toLowerCase();
  return x === 'sept' ? 8 : FULL_MONTHS.findIndex((f, i) => x === f || x === MONTHS[i]);
};
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const iso = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};
const addDays = (isoDate: string, n: number) => new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

/** Reason keywords map onto the configured delay-reason codes (`po.delay_reasons`); unmatched text returns null. */
const REASON_WORDS: [RegExp, string][] = [
  [/raw material|material shortage|steel|forging|casting lot|stock[- ]?out|out of stock/i, 'Raw material shortage'],
  [/capacity|production|machine|breakdown|power cut|shutdown|manpower/i, 'Production capacity'],
  [/transport|truck|lorry|tanker|vehicle|logistic|transporter|no vehicle/i, 'Transport unavailable'],
  [/clarif|drawing|specification|spec sheet|technical query/i, 'Awaiting technical clarification'],
  [/advance|payment pending|payment not received|overdue payment/i, 'Payment / advance pending'],
  [/import|oem|customs|port|lead time|factory dispatch/i, 'Import / OEM lead time'],
  [/quality|rework|re-work|rejection|failed inspection/i, 'Quality rework'],
];

export interface ReplyReading {
  dates: { date: string; matched: string; confidence: 'high' | 'medium' }[];
  /** Date to pre-fill (first future date mentioned), or null when the reply names none. */
  suggested_date: string | null;
  suggested_reason: string | null;
  signals: { dispatched: boolean; refs: string[] };
  note: string;
}

export function readReply(text: string, todayIso: string, allowedReasons: string[]): ReplyReading {
  const t = text.replace(/\s+/g, ' ').trim();
  const [ty, tm, td] = todayIso.split('-').map(Number);
  const found: { date: string; matched: string; confidence: 'high' | 'medium'; at: number }[] = [];
  const push = (date: string | null, matched: string, at: number, confidence: 'high' | 'medium') => {
    if (date && !found.some((f) => f.date === date)) found.push({ date, matched, confidence, at });
  };
  const yearGuess = (m: number, d: number) => {
    const same = iso(ty, m, d);
    return same && same >= todayIso ? same : iso(ty + 1, m, d);
  };

  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(iso(+m[1], +m[2], +m[3]), m[0], m.index!, 'high');
  // India writes day first: 15/11/2026, 15-11-26
  for (const m of t.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b/g)) push(iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]), m[0], m.index!, 'high');
  // 15 Nov, 15th November 2026
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?/g)) {
    const mi = monthIndex(m[2]);
    if (mi >= 0) push(m[3] ? iso(+m[3], mi + 1, +m[1]) : yearGuess(mi + 1, +m[1]), m[0], m.index!, m[3] ? 'high' : 'medium');
  }
  // Nov 15, November 15th
  for (const m of t.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/g)) {
    const mi = monthIndex(m[1]);
    if (mi >= 0) push(m[3] ? iso(+m[3], mi + 1, +m[2]) : yearGuess(mi + 1, +m[2]), m[0], m.index!, m[3] ? 'high' : 'medium');
  }
  for (const m of t.matchAll(/\bin\s+(\d{1,3})\s+(day|week)s?\b/gi)) push(addDays(todayIso, +m[1] * (m[2].toLowerCase() === 'week' ? 7 : 1)), m[0], m.index!, 'medium');
  for (const m of t.matchAll(/\b(tomorrow|today|day after tomorrow|next week)\b/gi)) {
    const k = m[1].toLowerCase();
    push(addDays(todayIso, k === 'today' ? 0 : k === 'tomorrow' ? 1 : k === 'next week' ? 7 : 2), m[0], m.index!, 'medium');
  }
  for (const m of t.matchAll(/\b(?:by|on|before|this|next|coming)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)) {
    const target = WEEKDAYS.indexOf(m[1].toLowerCase());
    const todayDow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay();
    let diff = (target - todayDow + 7) % 7;
    if (diff === 0) diff = 7;
    push(addDays(todayIso, diff), m[0].trim(), m.index!, 'medium');
  }

  found.sort((a, b) => a.at - b.at);
  const future = found.filter((f) => f.date >= todayIso);
  const reason = REASON_WORDS.find(([re]) => re.test(t))?.[1] ?? null;
  const refs = [...t.matchAll(/\b(?:LR|AWB|docket|consignment)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9-]{5,})/gi)].map((m) => m[1]);
  return {
    dates: found.map(({ date, matched, confidence }) => ({ date, matched, confidence })),
    suggested_date: future[0]?.date ?? null,
    suggested_reason: reason && allowedReasons.includes(reason) ? reason : null,
    signals: { dispatched: /\b(dispatched|shipped|despatched|handed over to transport|loaded)\b/i.test(t), refs },
    note: future.length
      ? 'Read by rules from explicit dates in the text. Check the date before recording it.'
      : found.length ? 'The only dates found are in the past. Enter the new date yourself.' : 'No delivery date found in the reply. Enter it yourself.',
  };
}
