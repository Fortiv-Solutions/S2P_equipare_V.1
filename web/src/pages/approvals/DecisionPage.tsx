import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, CornerUpLeft, ExternalLink, HelpCircle, MessageSquareReply, Undo2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtPct } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DecisionTag, KV, Loader, PageHeader, Ref, Status } from '@/components/ui';
import { Field, Textarea } from '@/components/forms';
import { ConfirmDialog, ReasonDialog } from '@/components/overlay';
import { ThreadView } from '@/components/Thread';
import { AuditTrail } from '@/components/AuditTrail';
import type { Detail } from './types';

export default function DecisionPage() {
  const id = Number(useParams().id);
  const q = useQuery<Detail>({ queryKey: ['approvals', 'detail', id], queryFn: () => api.get(`/approvals/${id}`) });
  return <Loader q={q} rows={10}>{(d) => <View d={d} />}</Loader>;
}

const humanize = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const isMoneyKey = (k: string) => /(landed|value|price|amount|total|difference|before|after|late_discount|risk_discount)/.test(k) && !/(pct|days|level|count)/.test(k);
const isPctKey = (k: string) => /pct$/.test(k);

function Scalar({ k, v }: { k: string; v: unknown }): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="subtle">—</span>;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return isPctKey(k) ? fmtPct(v / (Math.abs(v) > 1 ? 100 : 1)) : isMoneyKey(k) ? fmtMoney(v) : fmtNum(v);
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}T/.test(v) ? fmtDateTime(v) : /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : v;
  return <Nested v={v} />;
}

/** Render any JSON generically: objects as key/values, arrays of objects as tables, arrays of scalars as lists. */
function Nested({ v }: { v: unknown }): ReactNode {
  if (Array.isArray(v)) {
    if (!v.length) return <span className="subtle">None</span>;
    if (v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      const cols = [...new Set(v.flatMap((x) => Object.keys(x as object)))];
      return (
        <div className="tbl-wrap" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-sm)' }}>
          <table className="tbl tbl--dense">
            <thead><tr>{cols.map((c) => <th key={c} className={typeof (v[0] as any)[c] === 'number' ? 'num' : undefined}>{humanize(c)}</th>)}</tr></thead>
            <tbody>{v.map((row, i) => <tr key={i}>{cols.map((c) => <td key={c} className={typeof (row as any)[c] === 'number' ? 'num' : undefined} style={{ whiteSpace: 'normal', minWidth: 80 }}><Scalar k={c} v={(row as any)[c]} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
    return <ul className="list-plain" style={{ margin: 0, paddingLeft: 16 }}>{v.map((x, i) => <li key={i}><Scalar k="" v={x} /></li>)}</ul>;
  }
  if (v && typeof v === 'object') {
    return <KV items={Object.entries(v).map(([k, x]) => [humanize(k), <Scalar key={k} k={k} v={x} />])} />;
  }
  return <Scalar k="" v={v} />;
}

function ContextCard({ d }: { d: Detail }) {
  const skip = new Set(['recommended_by', 'recommended_by_name', ...(d.panel?.kind === 'comparison' ? ['lines', 'justification', 'deviation_reason', 'selected_vendors', 'landed_cost_basis'] : []), ...(d.panel?.kind === 'config_change' ? ['key', 'from', 'to'] : [])]);
  const entries = Object.entries(d.context).filter(([k, v]) => !skip.has(k) && v !== undefined);
  const simple = entries.filter(([, v]) => v === null || typeof v !== 'object');
  const rich = entries.filter(([, v]) => v !== null && typeof v === 'object');
  if (!entries.length && !d.reason) return null;
  return (
    <Card title="Request details">
      <div className="stack">
        {d.reason && <KV items={[['Reason given', <span style={{ whiteSpace: 'pre-wrap' }}>{d.reason}</span>]]} />}
        {simple.length > 0 && <KV cols items={simple.map(([k, v]) => [humanize(k), <Scalar key={k} k={k} v={v} />])} />}
        {rich.map(([k, v]) => <div key={k} className="stack-sm"><span className="small muted" style={{ fontWeight: 600 }}>{humanize(k)}</span><Nested v={v} /></div>)}
      </div>
    </Card>
  );
}

function ComparisonPanel({ p }: { p: any }) {
  if (!p?.id) return null;
  return (
    <Card title={<div className="row-wrap"><h2>Comparison and award</h2><Ref to={`/comparisons/${p.id}`}>{p.ref}</Ref><Status value={p.status} /></div>}
      actions={<ButtonLink to={`/comparisons/${p.id}`} size="sm" icon={<ExternalLink size={14} />}>Open full statement</ButtonLink>}>
      <div className="stack">
        {p.recommendation && <KV cols items={[['Recommended by', p.recommendation.by_name], ['Awarded landed cost', fmtMoney(p.recommendation.total_landed)], ['Lowest landed, same quantities', fmtMoney(p.recommendation.lowest_total)], ['Difference', <span style={{ color: p.recommendation.difference > 0.5 ? 'var(--bad)' : undefined, fontWeight: 600 }}>{fmtMoney(p.recommendation.difference)}</span>]]} />}
        {p.justification && <div><span className="small muted" style={{ fontWeight: 600 }}>Justification</span><p style={{ margin: '2px 0 0' }}>{p.justification}</p></div>}
        {p.deviation && <Callout tone="decision" title="Not the lowest landed cost — deviation remarks">{p.deviation_reason}</Callout>}
        {p.lines?.length > 0 && (
          <div className="stack-sm">
            <span className="small muted" style={{ fontWeight: 600 }}>Selected vendor against the lowest, LPP and contract price</span>
            {p.lines.map((l: any) => (
              <div key={l.line} className="card" style={{ padding: 12 }}>
                <div className="row between" style={{ alignItems: 'flex-start' }}><strong>{l.line} · {l.material}</strong><span className="small muted">{l.qty}{l.pr ? ` · PR ${l.pr}` : ''}</span></div>
                <div className="grid-2" style={{ marginTop: 8 }}>
                  <div className="stack-sm" style={{ gap: 2 }}>
                    <span className="small muted">Selected vendor</span><strong>{l.selected_vendor}</strong>
                    <span>{fmtMoney(l.selected_unit_landed)} unit landed · {l.delivery_days ?? '—'} days</span>
                    <span className="small muted">Delivery: {l.delivery_impact}</span>
                  </div>
                  <div className="stack-sm" style={{ gap: 2 }}>
                    <span className="small muted">Lowest landed cost</span><strong>{l.lowest_vendor || '—'}</strong>
                    <span>{fmtMoney(l.lowest_unit_landed)} unit landed · {l.lowest_delivery_days ?? '—'} days</span>
                    <span className="small" style={{ color: l.difference > 0.5 ? 'var(--bad)' : 'var(--ok)' }}>{l.difference > 0.5 ? `+${fmtMoney(l.difference)} over lowest` : 'Lowest landed cost'}</span>
                  </div>
                </div>
                <div className="row-wrap" style={{ marginTop: 8, gap: 14 }}>
                  <span className="small">LPP {fmtMoney(l.lpp)} {l.variance_vs_lpp_pct != null && <span style={{ color: l.variance_vs_lpp_pct > 0 ? 'var(--bad)' : 'var(--ok)' }}>({l.variance_vs_lpp_pct > 0 ? '+' : ''}{fmtPct(l.variance_vs_lpp_pct)})</span>}</span>
                  <span className="small">Contract price {l.contract_price != null ? `${fmtMoney(l.contract_price)} (${l.contract_no})` : 'no valid contract'}</span>
                </div>
                {l.reason && <p className="small" style={{ margin: '6px 0 0' }}><strong>Deviation remark:</strong> {l.reason}</p>}
              </div>
            ))}
          </div>
        )}
        {p.skipped?.length > 0 && p.skipped.map((s: any) => <Callout key={s.rfq_line_id} tone="warn" title={`Line ${s.line} not awarded`}>{s.reason}</Callout>)}
        {p.coverage && <p className="small muted" style={{ margin: 0 }}>Enquiry coverage: {p.coverage.responded} of {p.coverage.invited} invited vendors responded; {p.coverage.declined} declined; non-participating: {p.coverage.vendors.filter((v: any) => v.status === 'Non-participating').map((v: any) => v.name).join(', ') || 'none'}.</p>}
        {p.discounts?.length > 0 && <div className="stack-sm"><span className="small muted" style={{ fontWeight: 600 }}>Late / risk discounts</span><Nested v={p.discounts.map((x: any) => ({ line: x.line, vendor: x.vendor, late_discount: x.late, risk_discount: x.risk, status: x.status, reason: x.reason }))} /></div>}
      </div>
    </Card>
  );
}

function ConfigPanel({ p }: { p: any }) {
  const show = (v: unknown) => (v !== null && typeof v === 'object' ? <pre className="mono small" style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(v, null, 2)}</pre> : <span className="mono">{String(v)}</span>);
  return (
    <Card title={<div className="row-wrap"><h2>Configuration change</h2>{p.decision && <DecisionTag id={p.decision} />}</div>} actions={<ButtonLink to="/admin/config" size="sm" icon={<ExternalLink size={14} />}>Open business rules</ButtonLink>}>
      <div className="stack">
        <KV items={[['Setting', <><strong>{p.label ?? p.key}</strong> <span className="mono small subtle">{p.key}</span></>], ['What it controls', p.description], ['Change status', <Status value={p.change_status} />]]} />
        <div className="grid-2">
          <div className="stack-sm"><span className="small muted" style={{ fontWeight: 600 }}>Current value (from)</span><div className="card" style={{ padding: 10, background: 'var(--bad-bg)' }}>{show(p.from)}</div></div>
          <div className="stack-sm"><span className="small muted" style={{ fontWeight: 600 }}>Proposed value (to)</span><div className="card" style={{ padding: 10, background: 'var(--ok-bg)' }}>{show(p.to)}</div></div>
        </div>
      </div>
    </Card>
  );
}

function StepsCard({ d }: { d: Detail }) {
  const levels = [...new Set(d.steps.map((s) => s.level))];
  return (
    <Card title="Approval route" actions={<span className="small muted">Matrix: {d.matrix.name} · {d.matrix.fallback ? 'fallback route' : `version ${d.matrix.version}`}</span>}>
      <div className="stack">
        {d.matrix.fallback && <Callout tone="warn" title="No matrix row matched">The Procurement Manager fallback applies until Equipcare's approval matrix is approved <DecisionTag id="DEC-13" />.</Callout>}
        <ol className="timeline">
          {levels.map((lv) => {
            const st = d.steps.filter((s) => s.level === lv);
            const label = d.levels.find((l) => l.level === lv)?.label;
            return (
              <li key={lv}>
                <span className="timeline__dot" data-tone={st.every((s) => s.status === 'Approved') ? 'ok' : st.some((s) => s.status === 'Rejected') ? 'bad' : st.some((s) => s.status === 'Pending') ? 'decision' : undefined} />
                <div className="timeline__title">Level {lv}{label ? ` — ${label}` : ''}{st.length > 1 && <> <Badge tone="info">Parallel: all {st.length} must approve</Badge></>}</div>
                <div className="stack-sm" style={{ marginTop: 4 }}>
                  {st.map((s) => (
                    <div key={s.id} className="small">
                      <Status value={s.status === 'Waiting' ? 'Waiting' : s.status} /> <strong>{s.role_label}</strong>
                      {s.acted_by_name ? <> — {s.acted_by_name}{s.delegated_from_name ? ` (delegate of ${s.delegated_from_name})` : ''}</> : s.holders.length ? <span className="muted"> — {s.holders.join(' / ')}</span> : null}
                      {s.acted_at && <span className="muted"> · {fmtDateTime(s.acted_at)}{s.device ? ` · ${s.device}` : ''}</span>}
                      {s.escalated ? <> <Badge tone="bad">Escalated</Badge></> : null}
                      {s.due_at && s.status === 'Pending' && <span className="muted"> · due {fmtDateTime(s.due_at)}</span>}
                      {s.comment && <div style={{ marginTop: 2 }}>“{s.comment}”</div>}
                    </div>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </Card>
  );
}

function View({ d }: { d: Detail }) {
  const { can, me } = useAuth();
  const [dlg, setDlg] = useState<'reject' | 'return' | 'clarify' | 'answer' | 'withdraw' | 'approve' | null>(null);
  const [comment, setComment] = useState('');
  const inv = [['approvals'], ['cmp'], ['nav-counts'], ['pr'], ['comments']];
  const post = (action: string, body: object) => api.post(`/approvals/${d.id}/${action}`, body);
  const approve = useAction(() => post('approve', { comment: comment.trim() || null }), { success: `${d.req_no} approved`, invalidate: inv, onSuccess: () => setComment('') });
  const reject = useAction((c: string) => post('reject', { comment: c }), { success: `${d.req_no} rejected`, invalidate: inv });
  const ret = useAction((c: string) => post('return', { comment: c }), { success: `${d.req_no} returned to the requester`, invalidate: inv });
  const clarify = useAction((c: string) => post('clarify', { comment: c }), { success: 'Clarification requested', invalidate: inv });
  const answer = useAction((c: string) => post('answer', { answer: c }), { success: 'Answer sent — the request is back with the approver', invalidate: inv });
  const withdraw = useAction((c: string) => post('withdraw', { reason: c }), { success: `${d.req_no} withdrawn`, invalidate: inv });
  const open = ['Pending', 'Clarification requested'].includes(d.status);
  const decider = can('apr.decide');

  const actions = (
    <>
      {d.can_act && (
        <div className="stack">
          {d.acting_as_delegate_for && <Callout tone="decision" title={`Acting as delegate for ${d.acting_as_delegate_for}`}>Your decision is recorded as delegated.</Callout>}
          <Field label="Comment" hint="Optional for approval. Required to reject, return or ask for clarification (at least 5 characters)."><Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} /></Field>
          <div className="row-wrap">
            <Button variant="ok" icon={<Check />} loading={approve.busy} onClick={() => setDlg('approve')}>Approve</Button>
            <Button variant="danger" icon={<X />} onClick={() => setDlg('reject')}>Reject</Button>
            <Button icon={<CornerUpLeft />} onClick={() => setDlg('return')}>Return to buyer</Button>
            <Button icon={<HelpCircle />} onClick={() => setDlg('clarify')}>Ask clarification</Button>
          </div>
        </div>
      )}
      {!d.can_act && decider && open && d.why_not && <Callout tone="warn" title="You cannot decide this request">{d.why_not}</Callout>}
      {d.can_answer && (
        <div className="stack-sm">
          <Callout tone="warn" title="The approver asked for clarification">{d.comments.filter((c) => /^Clarification requested/.test(c.body)).slice(-1)[0]?.body.replace('Clarification requested: ', '') ?? 'See the comments below.'}</Callout>
          <Button variant="deep" icon={<MessageSquareReply />} onClick={() => setDlg('answer')}>Answer clarification</Button>
        </div>
      )}
      {d.can_withdraw && <div><Button variant="ghost" icon={<Undo2 />} onClick={() => setDlg('withdraw')}>Withdraw this request</Button></div>}
      {!open && <Callout tone={d.status === 'Approved' ? 'ok' : d.status === 'Withdrawn' ? 'info' : 'warn'} title={`${d.status}${d.decided_at ? ` ${fmtDateTime(d.decided_at)}` : ''}`}>{d.outcome ?? 'No comment recorded.'}</Callout>}
    </>
  );

  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/approvals">Approvals</Link><span>/</span><span className="mono">{d.req_no}</span></>} screen="SCR-APR-02" title={d.title}
        badges={<><Status value={d.status} />{d.category === 'exception' && <Badge tone="decision">Exception</Badge>}{d.urgency && d.urgency !== 'Normal' && <Badge tone="warn">{d.urgency}</Badge>}</>}
        sub={<>{d.type_label} · raised by {d.requester_name ?? '—'}{d.requester_title ? `, ${d.requester_title}` : ''} · {fmtDateTime(d.created_at)} · {d.age_days} d old</>}
        actions={d.linked.link ? <ButtonLink to={d.linked.link} className="btn--wrap" icon={<ArrowRight size={16} />}>Open {d.linked.label.toLowerCase()}{d.linked.ref ? ` ${d.linked.ref}` : ''}</ButtonLink> : undefined}
      />
      <div className="split">
        <div className="stack">
          <Card title="Summary">
            <div className="stack">
              {d.summary && <p style={{ margin: 0, fontSize: 'var(--fs-16)' }}>{d.summary}</p>}
              <KV cols items={[
                ['Value', d.value != null ? fmtMoney(d.value) : '—'], ['Type', d.type_label], ['Raised by', d.requester_name], ...(d.recommended_by_name ? [['Recommended by', d.recommended_by_name] as [string, string]] : []),
                ['Level now', open ? `${d.current_level} of ${new Set(d.steps.map((s) => s.level)).size}` : '—'], ['Plant', d.plant], ['Linked record', d.linked.link ? <Link to={d.linked.link}>{d.linked.ref ?? d.linked.label}</Link> : '—'],
                ['Matrix applied', `${d.matrix.name} · ${d.matrix.fallback ? 'fallback' : `v${d.matrix.version}`}`],
              ]} />
              {actions}
            </div>
          </Card>
          {d.panel?.kind === 'comparison' && <ComparisonPanel p={d.panel} />}
          {d.panel?.kind === 'config_change' && <ConfigPanel p={d.panel} />}
          <ContextCard d={d} />
          <Card title="Comments and clarifications"><ThreadView messages={d.comments} /></Card>
          <Card title="Audit history"><AuditTrail objectType="approval" objectId={d.id} /></Card>
        </div>
        <div className="stack"><StepsCard d={d} />{me && null}</div>
      </div>

      <ConfirmDialog open={dlg === 'approve'} onClose={() => setDlg(null)} onConfirm={() => approve.run()} title={`Approve ${d.req_no}?`} confirmLabel="Approve" variant="ok">
        <p>{d.title}{d.value != null ? ` — ${fmtMoney(d.value, true)}` : ''}. The decision, your role and device are recorded.</p>
      </ConfirmDialog>
      <ReasonDialog open={dlg === 'reject'} onClose={() => setDlg(null)} title="Reject this request" label="Comment" minLength={5} confirmLabel="Reject" variant="danger" onSubmit={(c) => reject.run(c)} sub="The requester is told why. A comment is required." />
      <ReasonDialog open={dlg === 'return'} onClose={() => setDlg(null)} title="Return to the buyer" label="Comment" minLength={5} confirmLabel="Return" variant="deep" onSubmit={(c) => ret.run(c)} sub="The request restarts from level 1 once it is changed and sent again." />
      <ReasonDialog open={dlg === 'clarify'} onClose={() => setDlg(null)} title="Ask for clarification" label="Your question" minLength={5} confirmLabel="Ask" variant="decision" onSubmit={(c) => clarify.run(c)} sub="The request pauses until the requester answers." />
      <ReasonDialog open={dlg === 'answer'} onClose={() => setDlg(null)} title="Answer the clarification" label="Your answer" minLength={5} confirmLabel="Send answer" variant="deep" onSubmit={(c) => answer.run(c)} />
      <ReasonDialog open={dlg === 'withdraw'} onClose={() => setDlg(null)} title="Withdraw this request" label="Reason" confirmLabel="Withdraw" variant="danger" onSubmit={(c) => withdraw.run(c)} sub="Open approval steps are closed. The linked record returns to its previous step." />
    </>
  );
}
