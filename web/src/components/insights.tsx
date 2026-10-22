/**
 * Shared pieces of the assistance layer: the ask box, work and risk lists, the workspace pipeline and KPI cards.
 * Everything here labels where a suggestion comes from ("Rules" or "AI-worded") and what is simulated.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BellRing, CheckCircle2, Clock3, Lightbulb, Search, Sparkles, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtMoney, fmtNum, fmtPct } from '@/lib/format';
import { Badge, Button, Empty, ErrorState, Kpi, LoadingBlock } from '@/components/ui';
import { useToast } from '@/components/overlay';

// ---------------------------------------------------------------- types
export interface Attention { title: string; subtitle?: string; link: string; tone?: 'ok' | 'warn' | 'bad' | 'info' | 'decision'; tag?: string; due?: string | null; hint: string | null }
export interface RiskItem {
  kind: 'po_delivery' | 'invoice_held' | 'payment' | 'rfq_response' | 'contract'; severity: 'High' | 'Medium'; title: string; subtitle?: string; why: string[]; link: string; score: number; next?: string;
  action?: { type: 'remind'; po_id: number; line_id: number; reminder: string; label: string };
}
export interface KpiCard { id: string; name: string; unit: string; value: number | null; n: number; note: string | null; link: string }
export interface Stage { key: string; label: string; count: number; hint?: string; link: string; tone?: 'ok' | 'warn' | 'bad' }
export interface AiInfo { mode: 'rules' | 'rules+model'; keyPresent: boolean; enabled: boolean; active: boolean; model: string; note: string }

const toneColor = (t?: string) => (t === 'bad' ? 'var(--bad)' : t === 'warn' ? 'var(--amber-500)' : t === 'decision' ? 'var(--berry-600)' : t === 'ok' ? 'var(--ok)' : 'var(--primary-600)');

// ---------------------------------------------------------------- source label
/** Says where a suggestion came from. Rules text is not an AI model, and the label never pretends otherwise. */
export function SourceTag({ source, model }: { source: 'rules' | 'model'; model?: string }) {
  return source === 'model'
    ? <Badge tone="deep" plain title={`Worded by ${model ?? 'an AI model'} from facts the rules computed`}><Sparkles size={12} aria-hidden /> AI-worded</Badge>
    : <Badge tone="neutral" plain title="Computed by deterministic rules. No AI model was used."><Lightbulb size={12} aria-hidden /> Rules</Badge>;
}

// ---------------------------------------------------------------- ask
const EXAMPLES = ['Which POs are late?', 'Which invoices are on hold and why?', 'What is waiting for my approval?', 'Payments due this week', 'Which POs are likely to be late?', 'Contracts expiring soon'];

interface AskAnswer { q: string; intent: string | null; understood: string; total: number; rows: { title: string; subtitle?: string; tag?: string; tone?: 'ok' | 'warn' | 'bad' | 'info' | 'decision'; link: string }[]; viewAll?: { label: string; link: string }; examples?: string[] }

/** Plain-language questions over read-only queries. Rules-based, and says how it understood the question. */
export function AskBox() {
  const [text, setText] = useState('');
  const [asked, setAsked] = useState('');
  const q = useQuery<AskAnswer>({ queryKey: ['insights', 'ask', asked], queryFn: () => api.get('/insights/ask', { q: asked }), enabled: asked.length >= 2, staleTime: 30_000 });
  const submit = (e?: FormEvent, v = text) => { e?.preventDefault(); const t = v.trim(); if (t.length >= 2) setAsked(t); };
  const pick = (e: string) => { setText(e); submit(undefined, e); };
  return (
    <section className="ask" aria-label="Ask the procurement data">
      <form className="ask__bar" onSubmit={submit} role="search">
        <Search aria-hidden />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about your data, e.g. “Which POs are late?”" aria-label="Ask a question about POs, invoices, approvals, RFQs or contracts" maxLength={200} />
        <Button type="submit" variant="primary" disabled={text.trim().length < 2} loading={q.isFetching}>Ask</Button>
      </form>
      {!asked && (
        <div className="ask__chips">
          <span className="small muted">Try</span>
          {EXAMPLES.map((e) => <button key={e} type="button" className="chip chip--btn" onClick={() => pick(e)}>{e}</button>)}
        </div>
      )}
      {asked && (
        <div className="ask__answer" aria-live="polite">
          {q.isLoading ? <LoadingBlock rows={3} /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : q.data && (
            <>
              <div className="row between" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
                <div className="row-wrap"><strong>{q.data.intent ? `${q.data.total} found` : 'Not understood'}</strong><span className="small muted">{q.data.understood}</span></div>
                <div className="row-wrap"><SourceTag source="rules" /><Button size="sm" variant="ghost" icon={<X />} onClick={() => { setAsked(''); setText(''); }}>Clear</Button></div>
              </div>
              {q.data.intent === null ? (
                <div className="stack-sm">
                  <p className="small muted" style={{ margin: 0 }}>This box understands questions about late deliveries, acknowledgements, held invoices, payments, approvals, RFQs, contracts, PR lines, disputes, advances and vendors. It is not a chatbot. Try one of these:</p>
                  <div className="ask__chips">{(q.data.examples ?? EXAMPLES).map((e) => <button key={e} type="button" className="chip chip--btn" onClick={() => pick(e)}>{e}</button>)}</div>
                </div>
              ) : q.data.rows.length === 0 ? (
                <p className="small" style={{ margin: 0 }}><CheckCircle2 size={14} aria-hidden style={{ verticalAlign: '-2px', color: 'var(--ok)' }} /> Nothing matches. That is good news if you were looking for problems.</p>
              ) : (
                <ul className="list-plain ask__rows">
                  {q.data.rows.map((r, i) => (
                    <li key={i}>
                      <Link to={r.link} className="ask__row">
                        <span className="ask__tone" style={{ background: toneColor(r.tone) }} aria-hidden />
                        <span className="grow" style={{ minWidth: 0 }}><span style={{ display: 'block', fontWeight: 600 }}>{r.title}</span>{r.subtitle && <span className="small muted">{r.subtitle}</span>}</span>
                        {r.tag && <Badge tone={r.tone === 'bad' ? 'bad' : r.tone === 'warn' ? 'warn' : r.tone === 'decision' ? 'decision' : r.tone === 'ok' ? 'ok' : 'info'} plain>{r.tag}</Badge>}
                        <ArrowRight size={16} color="var(--text-3)" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {q.data.total > q.data.rows.length && <p className="small muted" style={{ margin: '8px 0 0' }}>Showing {q.data.rows.length} of {q.data.total}.</p>}
              {q.data.viewAll && q.data.intent && <div style={{ marginTop: 8 }}><Link to={q.data.viewAll.link} className="small">{q.data.viewAll.label} →</Link></div>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- work list
/** Work that needs a person, with a one-line next step from the rules. */
export function AttentionList({ items, empty }: { items: Attention[]; empty?: string }) {
  if (!items.length) return <Empty title="You are clear for now" icon={<CheckCircle2 size={24} />}>{empty ?? 'New work appears here as soon as it needs you.'}</Empty>;
  return (
    <ul className="list-plain">
      {items.map((t, i) => (
        <li key={i} style={{ borderBottom: i < items.length - 1 ? '1px solid var(--steel-100)' : undefined }}>
          <Link to={t.link} className="row" style={{ padding: '12px 18px', color: 'inherit', textDecoration: 'none', gap: 14, alignItems: 'flex-start' }}>
            <span style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: toneColor(t.tone), flex: 'none' }} aria-hidden />
            <span className="grow" style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600 }}>{t.title}</span>
              {t.subtitle && <span className="small muted" style={{ display: 'block' }}>{t.subtitle}</span>}
              {t.hint && <span className="small hint"><Lightbulb size={12} aria-hidden /> {t.hint}</span>}
            </span>
            {t.due && <span className="small subtle nowrap desktop-only"><Clock3 size={12} /> {fmtDate(t.due)}</span>}
            {t.tag && <Badge tone={t.tone === 'bad' ? 'bad' : t.tone === 'warn' ? 'warn' : t.tone === 'decision' ? 'decision' : 'info'} plain>{t.tag}</Badge>}
            <ArrowRight size={16} color="var(--text-3)" aria-hidden style={{ marginTop: 2 }} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- risk list
function RiskCard({ r }: { r: RiskItem }) {
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = () => { for (const k of ['insights', 'home', 'po', 'nav-counts']) qc.invalidateQueries({ queryKey: [k] }); };
  const poId = r.action ? r.action.po_id : Number(r.link.split('/').pop());
  const remind = useAction(() => api.post<{ po_no: string; lines: number; recipients: number }>(`/insights/po/${poId}/remind`, { line_id: r.action!.line_id }), {
    success: (x) => `Reminder sent for PO ${x.po_no}${x.recipients ? '' : ' (logged only: the vendor has no portal user)'}`, onSuccess: refresh,
  });
  const dismiss = useAction(() => api.post(`/insights/po/${poId}/dismiss`, {}), { onSuccess: () => { toast('Hidden for 24 hours', 'info'); refresh(); } });
  return (
    <li className="risk" data-sev={r.severity}>
      <div className="row between" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <Link to={r.link} className="risk__title">{r.title}</Link>
          {r.subtitle && <div className="small muted">{r.subtitle}</div>}
        </div>
        <Badge tone={r.severity === 'High' ? 'bad' : 'warn'}>{r.severity} risk</Badge>
      </div>
      <ul className="risk__why">{r.why.map((w) => <li key={w}>{w}</li>)}</ul>
      {r.next && <div className="small hint"><Lightbulb size={12} aria-hidden /> {r.next}</div>}
      <div className="row-wrap" style={{ marginTop: 8 }}>
        {r.action && <Button size="sm" variant="primary" icon={<BellRing />} loading={remind.busy} onClick={remind.fire}>{r.action.label}</Button>}
        <Link to={r.link} className="btn btn--secondary btn--sm">Open</Link>
        {r.kind === 'po_delivery' && <Button size="sm" variant="ghost" loading={dismiss.busy} onClick={dismiss.fire}>Not now</Button>}
        <span className="small subtle" style={{ marginLeft: 'auto' }}>Score {r.score} · rules</span>
      </div>
    </li>
  );
}

export function RiskList({ items, empty }: { items: RiskItem[]; empty?: string }) {
  if (!items.length) return <Empty title="Nothing at risk right now" icon={<CheckCircle2 size={24} />}>{empty ?? 'Late deliveries, held invoices, blocked payments, low RFQ response and ending contracts show up here before they cost you.'}</Empty>;
  return <ul className="list-plain risks">{items.map((r, i) => <RiskCard key={`${r.link}${i}`} r={r} />)}</ul>;
}

// ---------------------------------------------------------------- pipeline and KPIs
export function Pipeline({ stages }: { stages: Stage[] }) {
  return (
    <ol className="pipe" aria-label="Pipeline">
      {stages.map((s) => (
        <li key={s.key}>
          <Link to={s.link} className="pipe__stage" data-tone={s.tone}>
            <span className="pipe__count">{fmtNum(s.count)}</span>
            <span className="pipe__label">{s.label}</span>
            {s.hint && <span className="pipe__hint">{s.hint}</span>}
          </Link>
        </li>
      ))}
    </ol>
  );
}

export function kpiValue(k: Pick<KpiCard, 'unit' | 'value'>) {
  if (k.value == null) return '—';
  switch (k.unit) {
    case 'pct': return fmtPct(k.value, 0);
    case 'days': return `${k.value.toFixed(1)} d`;
    case 'hours': return `${k.value.toFixed(0)} h`;
    case 'money': return fmtMoney(k.value, true);
    case 'score': return k.value.toFixed(1);
    default: return fmtNum(k.value);
  }
}

export function KpiStrip({ kpis, last = '90 days' }: { kpis: KpiCard[]; last?: string }) {
  if (!kpis.length) return null;
  return (
    <div className="grid-4">
      {kpis.map((k) => <Kpi key={k.id} label={k.name} value={kpiValue(k)} meta={k.n ? `Last ${last} · ${fmtNum(k.n)} records · no target set` : `No records in the last ${last}`} to="/reports" />)}
    </div>
  );
}

export function AiFooter({ ai }: { ai?: AiInfo }) {
  if (!ai) return null;
  return <p className="small muted ai-foot"><Lightbulb size={13} aria-hidden /> {ai.note} <Link to="/admin/ai">AI assistance log</Link></p>;
}
