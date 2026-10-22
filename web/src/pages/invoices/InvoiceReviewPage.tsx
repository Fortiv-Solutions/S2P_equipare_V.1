import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BadgeCheck, Ban, CheckCheck, CircleDollarSign, FilePenLine, Gavel, Landmark, Lock, OctagonAlert, Pencil, Send, ShieldCheck, Undo2, UserPlus } from 'lucide-react';
import { api, ApiError, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtMoney, fmtPct } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DecisionTag, Freshness, KV, Loader, PageHeader, Ref, SimBadge, Status, Tabs } from '@/components/ui';
import { Field, Input, Select, Textarea, ErrorSummary } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';
import { TrackChain, chainFrom } from '@/components/TrackChain';
import { AuditTrail } from '@/components/AuditTrail';
import { CommentThread } from '@/components/Thread';
import { ExplainCard } from './ExplainCard';
import { ConfBar, OcrNote, OWNER_LABEL, RULE_TONE, RULE_WORD, showVal, type AdvanceInfo, type Exc, type Extracted, type FieldDef, type RuleResult } from './shared';

interface Values { header: Record<string, string | number | null>; lines: Record<string, string | number | null>[]; verified: string[] }
interface PoLine { id: number; item: number; material_code: string | null; description: string; qty: number; uom: string; unit_price: number; gst_rate: number; freight: number; hsn: string | null; received_qty: number; received_value: number; grns: { grn_no: string; qty: number; posting_date: string; is_service: number }[]; billed_elsewhere: number; billable: number }
interface Detail {
  id: number; inv_ref: string; status: string; sub_reason: string | null; vendor_invoice_no: string | null; invoice_date: string | null; fy: string | null; total_value: number | null; taxable_value: number | null; gst_amount: number | null; freight: number;
  on_behalf: number; is_service: number; created_at: string; approved_at: string | null; approved_by_name: string | null; uploaded_by_name: string | null; approval_note: string | null; dispute_hold: number;
  sap_doc_no: string | null; due_date: string | null; paid_at: string | null; payment_ref: string | null; tds: number | null; retention: number | null; advance_adjusted: number | null; deductions: { label: string; amount: number }[] | null;
  block_reason_internal: string | null; vendor_reason: string | null; rejected_reason: string | null; payment_advice: Record<string, unknown> | null; final: Record<string, unknown> | null;
  extracted: Extracted | null; values: Values | null; match: { ran_at: string; trigger: string; tolerance: Record<string, number>; tolerance_version: number; results: RuleResult[]; advance: AdvanceInfo | null; fds: { contract_no: string } | null } | null;
  parking: { mode: 'sap' | 'manual'; status?: string; message: string; at: string } | null;
  vendor: { id: number; name: string; sap_code: string; gstin: string; pan: string; bank_name: string; bank_account_masked: string; bank_ifsc: string; synced_at: string };
  plant: { code: string; name: string; gstin: string }; buyer_name: string | null; asn: { id: number; asn_no: string; status: string } | null; duplicate: { id: number; inv_ref: string; vendor_invoice_no: string; status: string } | null;
  contract: { id: number; contract_no: string; type: string; invoice_validation: number } | null;
  po: { id: number; po_no: string; po_date: string; payment_terms: string | null; delivery_terms: string | null; freight_terms: string | null; total_value: number; lines: PoLine[] };
  attachment: { id: number; filename: string; mime: string; size: number } | null;
  exceptions: Exc[]; events: { id: number; title: string; note: string | null; status: string | null; user_name: string | null; created_at: string; vendor_visible: number }[];
  corrections: { id: number; field: string; label: string; old_value: string | null; new_value: string | null; reason: string; user_name: string; created_at: string }[];
  disputes: { id: number; dsp_no: string; type: string; status: string; qty: number; owner_party: string; item: number | null }[];
  accuracy: { extracted: number; corrected: number; not_found: number; accuracy: number | null }; thresholds: Record<string, number>; header_fields: FieldDef[]; line_fields: FieldDef[];
  config: { parking_write: boolean; hold_rule: string; tolerance: Record<string, number>; tolerance_pending: boolean };
  can: { correct: boolean; resolve: boolean; approve: boolean; approve_blocked_reason: string | null; park: boolean; reject: boolean; dispute: boolean; comment: boolean };
  freshness: Record<string, { last_success: string | null; stale: boolean }>;
}

const CHAIN = ['Uploaded', 'Validated', 'Matched', 'Approved', 'Parked', 'Posted', 'Paid'];
function chainOf(d: Detail) {
  const s = d.status;
  let cur = 0;
  if (['OCR pending', 'Validation pending', 'Exception'].includes(s)) cur = 1;
  else if (s === 'Matched') cur = d.approved_at ? 3 : 2;
  else if (s === 'Parked') cur = 4;
  else if (['Posted', 'Payment due', 'Payment blocked'].includes(s)) cur = 5;
  else if (s === 'Payment released') cur = 7;
  else if (s === 'Rejected') cur = 1;
  const blockedAt = s === 'Exception' || s === 'Rejected' ? 1 : s === 'Payment blocked' ? 5 : undefined;
  return chainFrom(CHAIN, cur, { blockedAt, subs: { 1: d.sub_reason ?? undefined, 3: d.approved_by_name ?? undefined } });
}
const thr = (d: Detail, key: string) => d.thresholds[key] ?? d.thresholds.default ?? 0.85;

/** SCR-INV-03 — invoice review: document beside extracted fields, PO / GRN / SES, match results, exceptions, finance control. */
export default function InvoiceReviewPage() {
  const id = Number(useParams().id);
  const q = useQuery<Detail>({ queryKey: ['invoices', 'detail', id], queryFn: () => api.get(`/invoices/${id}`) });
  return <Loader q={q} rows={10}>{(d) => <Review d={d} />}</Loader>;
}

function Review({ d }: { d: Detail }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<'review' | 'history' | 'notes' | 'audit'>('review');
  const inv = [['invoices'], ['payments']];
  const locked = ['Parked', 'Posted', 'Payment due', 'Payment released', 'Payment blocked'].includes(d.status);
  const open = d.exceptions.filter((e) => e.status === 'Open');
  const [focus, setFocus] = useState<{ label: string; value: ReactNode; conf?: number } | null>(null);
  const revalidate = useAction(() => api.post(`/invoices/${d.id}/revalidate`), { success: 'Validation re-run', invalidate: inv });

  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/invoices">Invoices</Link><span>/</span><span className="mono">{d.inv_ref}</span></>} screen="SCR-INV-03"
        title={<>Invoice {d.vendor_invoice_no ?? d.inv_ref}</>}
        badges={<><Status value={d.status} />{d.status === 'Matched' && d.approved_at ? <Badge tone="ok">Finance approved</Badge> : null}{d.on_behalf ? <Badge tone="deep">Uploaded on vendor’s behalf</Badge> : null}{d.dispute_hold ? <Badge tone="bad">Dispute hold</Badge> : null}</>}
        sub={<>{d.vendor.name} · PO <Link className="mono" to={`/pos/${d.po.id}`}>{d.po.po_no}</Link> · {fmtMoney(d.total_value)} · invoice date {fmtDate(d.invoice_date)} · FY {d.fy}{d.is_service ? ' · service invoice (PO vs SES vs invoice)' : ''}</>}
        actions={<>
          {can('inv.review') && !locked && d.status !== 'Rejected' && <Button icon={<CheckCheck />} loading={revalidate.busy} onClick={revalidate.fire}>Re-run validation</Button>}
          <ButtonLink to="/invoices/exceptions" icon={<OctagonAlert size={16} />}>Exception queue</ButtonLink>
        </>}
      />
      <Card title={<div className="row-wrap"><h2>Status</h2><Freshness flow="INT-M12" label="SAP invoice status" /></div>}>
        <TrackChain steps={chainOf(d)} label="Invoice progress" />
        {d.status === 'Exception' && <div style={{ marginTop: 12 }}><Callout tone="bad" title={`${open.length} open exception${open.length === 1 ? '' : 's'}: ${d.sub_reason}`}>The invoice cannot be approved, parked or posted until each is resolved or approved by finance (FR-INV-19).</Callout></div>}
        {d.status === 'Validation pending' && <div style={{ marginTop: 12 }}><Callout tone="warn" title={d.sub_reason ?? 'Validation pending'}>The invoice re-matches automatically when SAP posts the missing receipt document.</Callout></div>}
        {d.status === 'Rejected' && <div style={{ marginTop: 12 }}><Callout tone="bad" title="Rejected to the vendor">Vendor was told: “{d.rejected_reason}”</Callout></div>}
        {locked && <div style={{ marginTop: 12 }}><Callout tone="info" icon={<Lock aria-hidden />} title="Locked after release to SAP">Original, extracted, corrected and final records are kept and can no longer be edited (AC-INV-11). Status now comes only from SAP (INT-M12).</Callout></div>}
      </Card>
      <div style={{ height: 16 }} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'review', label: 'Review', count: open.length || undefined }, { id: 'history', label: 'Timeline & corrections', count: d.corrections.length || undefined }, { id: 'notes', label: 'Internal notes' }, { id: 'audit', label: 'Audit history' }]} />

      {tab === 'review' && (
        <div className="stack">
          {open.length > 0 && can('inv.view') && <ExplainCard invoiceId={d.id} />}
          <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
            <Card title="Invoice document" actions={d.attachment && <a className="btn btn--ghost btn--sm" href={downloadUrl(`/files/${d.attachment.id}/download`)} target="_blank" rel="noreferrer">Download original</a>}>
              <Preview d={d} focus={focus} />
            </Card>
            <ExtractedFields d={d} onFocus={setFocus} />
          </div>
          {open.length > 0 || d.exceptions.length > 0 ? <ExceptionsCard d={d} /> : null}
          <div className="split">
            <div className="stack">
              <MatchCard d={d} />
              <PoCard d={d} />
            </div>
            <div className="stack">
              <FinanceControl d={d} />
              {d.match?.advance && d.match.advance.advances.length > 0 && <AdvanceCard a={d.match.advance} total={d.total_value} adjusted={d.advance_adjusted} />}
              {(d.sap_doc_no || d.paid_at || d.due_date) && <PaymentCard d={d} />}
              <Card title="Vendor and PO">
                <KV items={[
                  ['Vendor', <Ref to={`/vendors/${d.vendor.id}`}>{d.vendor.name}</Ref>], ['SAP code', d.vendor.sap_code], ['GSTIN', <span className="mono">{d.vendor.gstin}</span>], ['PAN', <span className="mono">{d.vendor.pan}</span>],
                  ['Bank (SAP master)', `${d.vendor.bank_name} ${d.vendor.bank_account_masked} · ${d.vendor.bank_ifsc}`], ['Plant GSTIN', <span className="mono">{d.plant.gstin} ({d.plant.code})</span>],
                  ['PO terms', `${d.po.payment_terms ?? '—'} · ${d.po.delivery_terms ?? '—'}`], ['Buyer', d.buyer_name], ['ASN', d.asn ? <Ref to={`/asns/${d.asn.id}`}>{d.asn.asn_no}</Ref> : '—'],
                  ['Contract', d.contract ? <Ref to={`/contracts/${d.contract.id}`}>{`${d.contract.contract_no} (${d.contract.type})`}</Ref> : '—'], ['Uploaded by', `${d.uploaded_by_name ?? '—'}${d.on_behalf ? ' (on vendor’s behalf)' : ''}`],
                ]} />
              </Card>
              {d.disputes.length > 0 && (
                <Card title="Disputes on this PO" actions={<DecisionTag id="DEC-20" />}>
                  <ul className="list-plain stack-sm">{d.disputes.map((x) => <li key={x.id} className="row between"><span><Ref to={`/disputes/${x.id}`}>{x.dsp_no}</Ref> · {x.type}{x.item ? ` · item ${x.item}` : ''} · owner {x.owner_party}</span><Status value={x.status} /></li>)}</ul>
                  <p className="small muted" style={{ marginTop: 8 }}>Hold rule: <strong>{d.config.hold_rule}</strong> — {d.config.hold_rule === 'full' ? 'the whole invoice is held while a dispute is open' : 'only disputed lines are held'}.</p>
                </Card>
              )}
            </div>
          </div>
        </div>
      )}
      {tab === 'history' && <HistoryTab d={d} />}
      {tab === 'notes' && <Card title="Internal notes"><CommentThread objectType="invoice" objectId={d.id} canPost={d.can.comment} /></Card>}
      {tab === 'audit' && <Card title="Audit history"><AuditTrail objectType="invoice" objectId={d.id} /></Card>}
    </>
  );
}

// ------------------------------------------------------------------ document preview
function Preview({ d, focus }: { d: Detail; focus: { label: string; value: ReactNode; conf?: number } | null }) {
  if (!d.attachment) return <Callout tone="warn">No file is attached to this invoice.</Callout>;
  const url = `/api/files/${d.attachment.id}/download?inline=1`;
  const isImg = d.attachment.mime.startsWith('image/');
  return (
    <div className="stack-sm">
      {focus && <div className="callout callout--info" aria-live="polite"><div><strong>{focus.label}:</strong> {focus.value}{focus.conf != null ? <span className="small muted"> · read at {(focus.conf * 100).toFixed(1)}%</span> : null}</div></div>}
      {isImg ? <img src={url} alt={`Invoice ${d.vendor_invoice_no ?? d.inv_ref} as uploaded`} style={{ width: '100%', maxHeight: 640, objectFit: 'contain', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', background: 'var(--surface-sunk)' }} />
        : <iframe title={`Invoice ${d.vendor_invoice_no ?? d.inv_ref} as uploaded`} src={url} style={{ width: '100%', height: 560, border: '1px solid var(--line)', borderRadius: 'var(--r-md)', background: '#fff' }} />}
      <p className="small muted" style={{ margin: 0 }}>{d.attachment.filename} · {d.extracted?.capture === 'photo' ? 'phone photo — lower read confidence' : 'PDF'}. Select a field on the right to see what the engine read. Field boxes need real OCR coordinates; none exist in the simulation.</p>
    </div>
  );
}

// ------------------------------------------------------------------ extracted fields
function ExtractedFields({ d, onFocus }: { d: Detail; onFocus: (f: { label: string; value: ReactNode; conf?: number } | null) => void }) {
  const [edit, setEdit] = useState<{ path: string; label: string; def: FieldDef; old: string | number | null } | null>(null);
  const [val, setVal] = useState('');
  const inv = [['invoices'], ['payments']];
  const correct = useAction((reason: string) => api.post(`/invoices/${d.id}/correct`, { field: edit!.path, value: val.trim() === '' ? null : val.trim(), reason }), { success: 'Field corrected and validation re-run', invalidate: inv });
  const verify = useAction((path: string) => api.post(`/invoices/${d.id}/verify`, { field: path }), { success: 'Value confirmed as read', invalidate: inv });
  const x = d.extracted;
  const v = d.values;
  if (!x || !v) return <Card title="Extracted fields"><Callout tone="warn">OCR has not run for this invoice.</Callout></Card>;
  const corrected = new Set(d.corrections.map((c) => c.field));

  const row = (path: string, def: FieldDef, label: string, read: { value: string | number | null; found: boolean; confidence: number }, current: string | number | null) => {
    const t = thr(d, def.key);
    const low = read.found && read.confidence < t && !v.verified.includes(path) && !corrected.has(path) && def.critical;
    const changed = corrected.has(path);
    return (
      <tr key={path} data-low={low || undefined} onClick={() => onFocus({ label, value: showVal(def, current), conf: read.found ? read.confidence : undefined })} style={{ cursor: 'pointer', background: low ? 'var(--warn-bg)' : undefined }}>
        <td style={{ whiteSpace: 'nowrap' }}>{label}{def.mandatory && <span className="subtle"> *</span>}</td>
        <td style={{ overflowWrap: 'anywhere' }}>
          {showVal(def, current)}
          {changed && <div className="small muted">Read as {read.found ? String(read.value) : 'not found'}</div>}
        </td>
        <td><ConfBar value={read.confidence} threshold={t} found={read.found} /></td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {d.can.correct && (
            <span className="row" style={{ gap: 4 }}>
              <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} onClick={(e) => { e.stopPropagation(); setEdit({ path, label, def, old: current }); setVal(current == null ? '' : String(current)); }}>Correct {label}</Button>
              {low && <Button size="sm" variant="ghost" iconOnly icon={<BadgeCheck />} loading={verify.busy} onClick={(e) => { e.stopPropagation(); verify.fire(path); }}>Confirm {label} as read</Button>}
            </span>
          )}
        </td>
      </tr>
    );
  };

  return (
    <Card
      title={<div className="stack-sm" style={{ gap: 4 }}><div className="row-wrap"><h2>Extracted fields</h2><SimBadge title="No OCR engine connected (DEC-01)">Simulated OCR</SimBadge></div><span className="small muted">{x.note ?? 'Simulated OCR — values come from the uploaded details; no OCR engine is connected'}</span></div>}
      actions={<span className="small muted" title="KPI-10 = fields not corrected ÷ fields extracted">Field accuracy {d.accuracy.accuracy == null ? '—' : fmtPct(d.accuracy.accuracy)} · {d.accuracy.corrected} of {d.accuracy.extracted} corrected</span>}
      flush
    >
      <div className="tbl-wrap" style={{ maxHeight: 640, overflow: 'auto' }}>
        <table className="tbl tbl--dense">
          <thead><tr><th>Field</th><th>Value</th><th>Confidence</th><th /></tr></thead>
          <tbody>
            {d.header_fields.map((f) => row(f.key, f, f.label, x.header[f.key], v.header[f.key] ?? null))}
            {v.lines.map((l, i) => (
              <FragmentRows key={i} title={`Line ${i + 1}${x.lines[i]?.po_item?.value != null ? ` · PO item ${l.po_item}` : ''}`}>
                {d.line_fields.map((f) => row(`lines.${i}.${f.key}`, f, f.label, x.lines[i][f.key], l[f.key] ?? null))}
              </FragmentRows>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '10px 14px' }} className="small muted">Confidence below the field threshold (cfg <span className="mono">ocr.confidence</span>) raises an exception. * mandatory. {d.can.correct ? 'Corrections need a reason and are recorded with old and new value.' : 'Only finance can correct fields.'}</div>
      <CorrectDialog edit={edit} val={val} setVal={setVal} onClose={() => setEdit(null)} onSubmit={(r) => correct.run(r)} error={correct.error} />
    </Card>
  );
}

function FragmentRows({ title, children }: { title: string; children: ReactNode }) {
  return <><tr><td colSpan={4} style={{ background: 'var(--surface-sunk)', fontWeight: 700, fontSize: 'var(--fs-12)' }}>{title}</td></tr>{children}</>;
}

function CorrectDialog({ edit, val, setVal, onClose, onSubmit, error }: { edit: { path: string; label: string; def: FieldDef; old: string | number | null } | null; val: string; setVal: (v: string) => void; onClose: () => void; onSubmit: (reason: string) => Promise<unknown>; error: unknown }) {
  const kind = edit?.def.kind;
  const empty = val.trim() === '';
  return (
    <ReasonDialog open={!!edit} onClose={onClose} title={`Correct ${edit?.label.toLowerCase() ?? 'field'}`} confirmLabel="Save correction" variant="deep" label="Reason for the correction"
      sub="The old value, new value, your name, the time and this reason are recorded (FR-INV-06). Validation and matching run again."
      extraValid={!(edit?.def.mandatory && empty)} onSubmit={onSubmit}>
      <ErrorSummary error={error instanceof ApiError ? error : null} />
      <Field label={`New ${edit?.label.toLowerCase() ?? 'value'}`} hint={`Currently: ${edit?.old ?? 'not found'}${kind === 'date' ? ' · format YYYY-MM-DD' : ''}`} required={!!edit?.def.mandatory}>
        <Input value={val} onChange={(e) => setVal(e.target.value)} type={kind === 'date' ? 'date' : 'text'} inputMode={kind === 'money' || kind === 'number' || kind === 'pct' ? 'decimal' : undefined} data-autofocus />
      </Field>
    </ReasonDialog>
  );
}

// ------------------------------------------------------------------ PO / GRN / invoice
function PoCard({ d }: { d: Detail }) {
  const doc = d.is_service ? 'SES' : 'GRN';
  return (
    <Card title={`PO lines, ${doc} and invoice`} actions={<span className="small muted">PO {d.po.po_no} · {fmtDate(d.po.po_date)} · synced PO data</span>} flush>
      <div className="tbl-wrap">
        <table className="tbl tbl--dense">
          <thead><tr><th>Item</th><th>Description</th><th className="num">PO qty</th><th className="num">PO rate</th><th className="num">GST</th><th className="num">{doc} received</th><th className="num">Billed before</th><th className="num">This invoice</th></tr></thead>
          <tbody>
            {d.po.lines.map((l) => {
              const il = d.values?.lines.find((x) => Number(x.po_item) === l.item);
              const over = il && Number(il.qty) > l.billable + 1e-9;
              return (
                <tr key={l.id}>
                  <td className="mono">{l.item}</td>
                  <td><div>{l.description}</div><div className="small subtle mono">{l.material_code}{l.hsn ? ` · HSN ${l.hsn}` : ''}</div></td>
                  <td className="num">{l.qty} {l.uom}</td><td className="num">{fmtMoney(l.unit_price)}</td><td className="num">{l.gst_rate}%</td>
                  <td className="num">{l.received_qty > 0 ? <span title={l.grns.map((g) => `${g.grn_no}: ${g.qty} on ${g.posting_date}`).join('\n')}>{l.received_qty} {l.uom}<div className="small subtle">{l.grns.map((g) => g.grn_no).join(', ')}</div></span> : <span className="subtle">None yet</span>}</td>
                  <td className="num">{l.billed_elsewhere || '—'}</td>
                  <td className="num">{il ? <span style={{ color: over ? 'var(--bad)' : undefined, fontWeight: over ? 700 : 500 }}>{il.qty} @ {fmtMoney(Number(il.rate))}</span> : <span className="subtle">Not billed</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ match results
function MatchCard({ d }: { d: Detail }) {
  const m = d.match;
  const tol = d.config.tolerance;
  const zero = Object.values(tol).every((x) => x === 0);
  return (
    <Card title={<div className="row-wrap"><h2>Match results</h2><span className="small muted">WF-10 rule order</span></div>} actions={<DecisionTag id="DEC-07" />}>
      <div className="stack">
        <Callout tone="decision" title={zero ? 'Tolerances are zero until approved' : 'Active 3-way match tolerances'}>
          {zero ? 'Procurement and finance must jointly approve tolerance values (GOV-C07). Until then every difference is an exception.' : `Price ${tol.price_pct}% / ${fmtMoney(tol.price_abs)}, quantity ${tol.qty_pct}%, tax ${fmtMoney(tol.tax_abs)}, freight ${fmtMoney(tol.freight_abs)}, total ${fmtMoney(tol.total_abs)}.`}
          {d.config.tolerance_pending ? ' A tolerance change is pending approval; matching uses the active values.' : ''}
        </Callout>
        {!m ? <Callout tone="info">Matching has not run yet.</Callout> : m.results.map((r) => (
          <details key={r.rule} open={r.status === 'fail' || r.status === 'waiting'} style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
            <summary style={{ cursor: 'pointer', padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge tone={RULE_TONE[r.status]}>{RULE_WORD[r.status]}</Badge>
              <strong>{r.label}</strong>
              <span className="small muted" style={{ flex: '1 1 220px' }}>{r.summary}</span>
              {r.rule === 'DISPUTE_HOLD' && <DecisionTag id="DEC-20" />}
            </summary>
            {r.checks.length > 0 && (
              <div className="tbl-wrap" style={{ borderTop: '1px solid var(--line)' }}>
                <table className="tbl tbl--dense">
                  <thead><tr><th>Item</th><th>Check</th><th>Expected</th><th>Actual</th><th>Tolerance</th><th>Result</th></tr></thead>
                  <tbody>{r.checks.map((c, i) => (
                    <tr key={i}>
                      <td className="mono">{c.item ?? '—'}</td>
                      <td>{c.check}{c.note && <div className="small subtle">{c.note}</div>}</td>
                      <td>{c.expected}</td><td style={{ fontWeight: c.ok ? 500 : 700 }}>{c.actual}</td><td className="small">{c.tolerance ?? '—'}</td>
                      <td><Badge tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'OK' : 'Differs'}</Badge></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </details>
        ))}
        {m && <p className="small muted" style={{ margin: 0 }}>Last run {fmtDateTime(m.ran_at)} ({m.trigger}) · tolerance version {m.tolerance_version}{m.fds ? ` · FDS price check against ${m.fds.contract_no}` : ''}.</p>}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ exceptions
function ExceptionsCard({ d }: { d: Detail }) {
  const { can } = useAuth();
  const [dlg, setDlg] = useState<{ kind: 'approve' | 'resolve' | 'assign'; ex: Exc } | null>(null);
  const inv = [['invoices'], ['payments']];
  const approve = useAction((reason: string) => api.post(`/invoices/exceptions/${dlg!.ex.id}/approve`, { reason }), { success: 'Exception approved', invalidate: inv });
  const lineId = (item: number | null) => d.po.lines.find((l) => l.item === item)?.id;
  const sorted = [...d.exceptions].sort((a, b) => (a.status === 'Open' ? 0 : 1) - (b.status === 'Open' ? 0 : 1));
  return (
    <Card title={<div className="row-wrap"><h2>Exceptions</h2><span className="small muted">{d.exceptions.filter((e) => e.status === 'Open').length} open of {d.exceptions.length}</span></div>}>
      <div className="stack">
        {sorted.map((e) => {
          const blocked = e.rule === 'DUP' ? 'A duplicate cannot be approved — reject it to the vendor.' : e.rule === 'FIELD_MISSING' ? 'Correct the missing field from the document.' : e.reason.startsWith('Pending') ? 'Clears itself when SAP posts the receipt.' : null;
          return (
            <div key={e.id} style={{ border: '1px solid var(--line)', borderLeft: `4px solid ${e.status !== 'Open' ? 'var(--ok)' : e.severity === 'high' ? 'var(--bad)' : 'var(--warn)'}`, borderRadius: 'var(--r-md)', padding: 12 }} className="stack-sm">
              <div className="row-wrap between">
                <div className="row-wrap"><strong>{e.reason}</strong><Badge tone={e.severity === 'high' ? 'bad' : e.severity === 'medium' ? 'warn' : 'neutral'}>{e.severity}</Badge><Status value={e.status} /><span className="small subtle">{e.rule_label}</span></div>
                <span className="small muted">Owner: <strong>{e.owner_name ?? `${OWNER_LABEL[e.owner_role] ?? e.owner_role} team`}</strong> · {e.age_days} d</span>
              </div>
              <div>{e.message}</div>
              {(e.expected || e.actual) && <div className="small"><span className="muted">Expected</span> <strong>{e.expected ?? '—'}</strong> <ArrowRight size={11} aria-hidden /> <span className="muted">actual</span> <strong>{e.actual ?? '—'}</strong>{e.tolerance ? <> · <span className="muted">tolerance</span> {e.tolerance} {e.rule.startsWith('3WM') || e.rule === 'FDS' ? <DecisionTag id="DEC-07" /> : null}</> : null}</div>}
              {e.status !== 'Open' && e.resolution && <div className="small muted">{e.status} by {e.resolved_by_name ?? 'system'} {fmtDateTime(e.resolved_at)} — {e.resolution}</div>}
              {e.auto_clear === 0 && e.status === 'Open' && <Callout tone="bad" title="Never cleared automatically (FR-INV-09)">Finance must decide on the bank details: correct the figure if it was misread, or reject the invoice to the vendor.</Callout>}
              {e.status === 'Open' && (
                <div className="row-wrap">
                  {d.can.resolve && !blocked && <Button size="sm" variant="decision" icon={<ShieldCheck />} onClick={() => setDlg({ kind: 'approve', ex: e })}>Approve exception</Button>}
                  {d.can.resolve && !blocked && e.rule !== 'BANK' && <Button size="sm" icon={<FilePenLine />} onClick={() => setDlg({ kind: 'resolve', ex: e })}>Record resolution</Button>}
                  {d.can.resolve && <Button size="sm" icon={<UserPlus />} onClick={() => setDlg({ kind: 'assign', ex: e })}>Assign owner</Button>}
                  {d.can.dispute && e.line_item && ['3WM-02', '3WM-03'].includes(e.rule) && <ButtonLink size="sm" icon={<Gavel size={14} />} to={`/disputes/new?invoice_id=${d.id}&po=${d.po.id}${lineId(e.line_item) ? `&po_line=${lineId(e.line_item)}` : ''}`}>Raise dispute</ButtonLink>}
                  {blocked && <span className="small muted">{blocked}</span>}
                </div>
              )}
            </div>
          );
        })}
        {!can('inv.review') && <p className="small muted" style={{ margin: 0 }}>Finance resolves exceptions. Owners are notified; you can follow progress here.</p>}
      </div>
      <ReasonDialog open={dlg?.kind === 'approve'} onClose={() => setDlg(null)} title="Approve this exception" confirmLabel="Approve exception" variant="decision" sub={dlg ? `${dlg.ex.reason}: ${dlg.ex.message}` : undefined} onSubmit={(r) => approve.run(r)} />
      <ResolveDialog ex={dlg?.kind === 'resolve' ? dlg.ex : null} onClose={() => setDlg(null)} />
      <AssignDialog ex={dlg?.kind === 'assign' ? dlg.ex : null} onClose={() => setDlg(null)} />
    </Card>
  );
}

function ResolveDialog({ ex, onClose }: { ex: Exc | null; onClose: () => void }) {
  const [res, setRes] = useState('Credit note received');
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction(() => api.post(`/invoices/exceptions/${ex!.id}/resolve`, { resolution: res, reference: ref || null, reason }), { success: 'Resolution recorded and validation re-run', invalidate: [['invoices'], ['payments']], onSuccess: () => { setRef(''); setReason(''); onClose(); } });
  return (
    <Modal open={!!ex} onClose={onClose} title="Record resolution" sub="Use when the cause is fixed outside this screen. Validation runs again; if the difference is still there the exception returns."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={reason.trim().length < 10} onClick={act.fire}>Record resolution</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="What was done" required><Select value={res} onChange={(e) => setRes(e.target.value)} options={['Credit note received', 'Corrected in SAP', 'PO amended', 'Other']} /></Field>
        <Field label="Reference (credit note, SAP document)" hint="Optional."><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={60} /></Field>
        <Field label="Reason" required hint="At least 10 characters. Recorded in the audit trail."><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

function AssignDialog({ ex, onClose }: { ex: Exc | null; onClose: () => void }) {
  const users = useQuery<{ id: number; name: string; roles: string; title: string | null }[]>({ queryKey: ['invoices', 'assignees'], queryFn: () => api.get('/invoices/assignees'), enabled: !!ex });
  const [user, setUser] = useState('');
  const [note, setNote] = useState('');
  const act = useAction(() => api.post(`/invoices/exceptions/${ex!.id}/assign`, { user_id: Number(user), note: note || undefined }), { success: 'Exception assigned', invalidate: [['invoices']], onSuccess: () => { setUser(''); setNote(''); onClose(); } });
  return (
    <Modal open={!!ex} onClose={onClose} title="Assign exception" sub="The new owner is notified (NTF-28)."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={!user} onClick={act.fire}>Assign</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="Owner" required><Select value={user} onChange={(e) => setUser(e.target.value)} placeholder="Choose a person" options={(users.data ?? []).map((u) => ({ value: u.id, label: `${u.name} — ${u.title ?? u.roles}` }))} /></Field>
        <Field label="Note for the owner" hint="Optional."><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ finance control (FR-INV-19)
function FinanceControl({ d }: { d: Detail }) {
  const { can } = useAuth();
  const [dlg, setDlg] = useState<'approve' | 'reject' | 'pay' | 'block' | null>(null);
  const inv = [['invoices'], ['payments']];
  const approve = useAction((note: string) => api.post(`/invoices/${d.id}/approve`, { note: note || undefined }), { success: `Invoice ${d.inv_ref} approved by finance`, invalidate: inv });
  const park = useAction(() => api.post<{ result: { status: string; message: string } }>(`/invoices/${d.id}/park`), {
    success: (r) => (r.result.status === 'Manual' ? 'Released for manual entry in SAP' : `SAP: ${r.result.status} — ${r.result.message}`), invalidate: inv,
  });
  const locked = ['Parked', 'Posted', 'Payment due', 'Payment released', 'Payment blocked'].includes(d.status);
  const sim = can('sapsim.fin', 'sapsim.all') && !!d.approved_at;
  const parkedOk = d.parking?.mode === 'sap' && ['Written', 'Duplicate'].includes(d.parking.status ?? '');
  const open = d.exceptions.filter((e) => e.status === 'Open').length;

  return (
    <Card title={<div className="row-wrap"><h2>Finance control</h2><DecisionTag id="DEC-06" /></div>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>The platform never parks, posts or pays on its own. A finance user approves a Matched invoice (or one whose exceptions are approved); only then can it go to SAP.</p>
        <ol className="stack-sm" style={{ margin: 0, paddingLeft: 18 }}>
          <li style={{ color: open === 0 && d.status !== 'Rejected' ? 'var(--ok)' : undefined }}>{open === 0 ? 'No open exceptions' : `${open} open exception${open === 1 ? '' : 's'} to resolve or approve`}</li>
          <li style={{ color: d.status === 'Matched' || locked ? 'var(--ok)' : undefined }}>{d.status === 'Matched' || locked ? 'Matched' : 'Must reach Matched'}</li>
          <li style={{ color: d.approved_at ? 'var(--ok)' : undefined }}>{d.approved_at ? `Approved by ${d.approved_by_name} on ${fmtDate(d.approved_at)}` : 'Finance approval pending'}</li>
          <li style={{ color: d.parking ? 'var(--ok)' : undefined }}>{d.parking ? (d.parking.mode === 'sap' ? `Parking request to SAP: ${d.parking.status}` : 'Released for manual SAP entry') : locked ? 'Handled in SAP' : 'Hand over to SAP'}</li>
        </ol>
        {d.approval_note && <p className="small muted" style={{ margin: 0 }}>Approval note: {d.approval_note}</p>}

        {d.status === 'Matched' && !d.approved_at && can('inv.review') && (
          <>
            {d.can.approve_blocked_reason && <Callout tone="warn">{d.can.approve_blocked_reason}</Callout>}
            <Button variant="ok" icon={<BadgeCheck />} disabled={!d.can.approve} onClick={() => setDlg('approve')}>Approve invoice (finance)</Button>
          </>
        )}
        {d.status !== 'Matched' && !locked && d.status !== 'Rejected' && <Callout tone="info">Approval opens once the invoice is Matched.</Callout>}

        {d.approved_at && d.status === 'Matched' && (
          <div className="stack-sm">
            {d.parking?.message && <Callout tone={d.parking.status === 'Failed' ? 'bad' : d.parking.status === 'Queued' ? 'warn' : 'info'} title={d.parking.mode === 'sap' ? `SAP parking: ${d.parking.status}` : 'Enter in SAP manually (DEC-06)'}>{d.parking.message}</Callout>}
            {!d.config.parking_write && !d.parking && <Callout tone="info" title="Enter in SAP manually (DEC-06)">Parking write-back to SAP is switched off. Release the invoice, then park or post it in SAP; its status returns through the INT-M12 sync.</Callout>}
            {d.can.park && !parkedOk && <Button variant="primary" icon={<Send />} loading={park.busy} onClick={park.fire}>{d.config.parking_write ? (d.parking ? 'Retry parking request to SAP' : 'Send parking request to SAP (INT-M11)') : d.parking ? 'Release again for manual entry' : 'Release for manual entry in SAP'}</Button>}
          </div>
        )}
        {locked && d.parking?.message && <Callout tone="info">{d.parking.message}</Callout>}
        {d.can.reject && <Button variant="danger" icon={<Undo2 />} onClick={() => setDlg('reject')}>Reject to vendor</Button>}
        {d.can.dispute && !locked && d.status !== 'Rejected' && <ButtonLink to={`/disputes/new?invoice_id=${d.id}&po=${d.po.id}`} icon={<Gavel size={16} />}>Raise dispute</ButtonLink>}

        {sim && <SimPanel d={d} onPay={() => setDlg('pay')} onBlock={() => setDlg('block')} />}
        {!sim && d.approved_at && !locked && <p className="small muted" style={{ margin: 0 }}>Parking and posting are done in SAP by the finance or SAP team; this page then shows the SAP status.</p>}
      </div>
      <ReasonDialog open={dlg === 'approve'} onClose={() => setDlg(null)} title="Approve this invoice" confirmLabel="Approve invoice" variant="ok" label="Approval note" minLength={0} sub="Confirms the invoice is matched (or its exceptions are approved). It does not post anything in SAP." onSubmit={(n) => approve.run(n)} />
      <RejectDialog d={d} open={dlg === 'reject'} onClose={() => setDlg(null)} />
      <PayDialog d={d} open={dlg === 'pay'} onClose={() => setDlg(null)} />
      <BlockDialog d={d} open={dlg === 'block'} onClose={() => setDlg(null)} />
    </Card>
  );
}

async function simPost(ref: string, action: string, body: Record<string, unknown> = {}) {
  try {
    return await api.post<any>(`/sap/sim/invoice/${encodeURIComponent(ref)}/${action}`, body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && /unknown api endpoint/i.test(e.message)) throw new Error('The SAP simulator API is not available on this server (404). Ask the integration team to enable it.');
    throw e;
  }
}

function SimPanel({ d, onPay, onBlock }: { d: Detail; onPay: () => void; onBlock: () => void }) {
  const inv = [['invoices'], ['payments']];
  const park = useAction(() => simPost(d.inv_ref, 'park'), { success: 'Parked in the SAP simulator; status synced', invalidate: inv });
  const post = useAction(() => simPost(d.inv_ref, 'post'), { success: 'Posted in the SAP simulator; status synced', invalidate: inv });
  const st = d.status;
  return (
    <div className="sim-panel stack-sm">
      <div className="row-wrap between"><strong className="small">SAP simulator</strong><SimBadge>Simulator</SimBadge></div>
      <p className="small" style={{ margin: 0 }}>Stands in for SAP in this MVP. Each action writes the SAP document; the status comes back through the INT-M12 sync. The simulator refuses invoices without finance approval.</p>
      <div className="row-wrap">
        <Button size="sm" icon={<Landmark />} loading={park.busy} disabled={st !== 'Matched'} onClick={park.fire}>Park in SAP</Button>
        <Button size="sm" icon={<Landmark />} loading={post.busy} disabled={!['Matched', 'Parked'].includes(st)} onClick={post.fire}>Post in SAP</Button>
        <Button size="sm" icon={<CircleDollarSign />} disabled={!['Posted', 'Payment due'].includes(st)} onClick={onPay}>Release payment</Button>
        <Button size="sm" variant="danger" icon={<Ban />} disabled={!['Posted', 'Payment due'].includes(st)} onClick={onBlock}>Block payment</Button>
      </div>
    </div>
  );
}

function RejectDialog({ d, open, onClose }: { d: Detail; open: boolean; onClose: () => void }) {
  const [vr, setVr] = useState('');
  const [note, setNote] = useState('');
  const act = useAction(() => api.post(`/invoices/${d.id}/reject`, { vendor_reason: vr, internal_note: note || undefined }), { success: `Invoice ${d.inv_ref} returned to the vendor`, invalidate: [['invoices'], ['payments']], onSuccess: () => { setVr(''); setNote(''); onClose(); } });
  return (
    <Modal open={open} onClose={onClose} title="Reject invoice to vendor" sub="The vendor is notified and sees the reason word for word."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" loading={act.busy} disabled={vr.trim().length < 10} onClick={act.fire}>Reject to vendor</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="Reason shown to the vendor" required hint="Vendor-safe wording only: what to fix, no internal remarks, tolerances, names or other vendors. At least 10 characters."><Textarea rows={3} value={vr} onChange={(e) => setVr(e.target.value)} maxLength={500} data-autofocus /></Field>
        <Field label="Internal note" hint="Optional. Never shown to the vendor."><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

function PayDialog({ d, open, onClose }: { d: Detail; open: boolean; onClose: () => void }) {
  const [tds, setTds] = useState('');
  const [ref, setRef] = useState('');
  const act = useAction(() => simPost(d.inv_ref, 'pay', { ...(tds !== '' ? { tds: Number(tds) } : {}), ...(ref ? { payment_ref: ref } : {}) }), { success: 'Payment released in the SAP simulator; status synced', invalidate: [['invoices'], ['payments']], onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Release payment (SAP simulator)" sub="TDS appears on the payment advice only if you enter it here, as SAP would provide it."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} onClick={act.fire}>Release payment</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="TDS deducted (₹)" hint="Leave empty if SAP provides no TDS."><Input inputMode="decimal" value={tds} onChange={(e) => setTds(e.target.value)} /></Field>
        <Field label="Payment reference" hint="Optional; SAP numbers it if empty."><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={40} /></Field>
      </div>
    </Modal>
  );
}

function BlockDialog({ d, open, onClose }: { d: Detail; open: boolean; onClose: () => void }) {
  const [internal, setInternal] = useState('');
  const [vendor, setVendor] = useState('');
  const act = useAction(() => simPost(d.inv_ref, 'block', { reason_internal: internal, vendor_reason: vendor }), { success: 'Payment blocked in the SAP simulator', invalidate: [['invoices'], ['payments']], onSuccess: () => { setInternal(''); setVendor(''); onClose(); } });
  return (
    <Modal open={open} onClose={onClose} title="Block payment (SAP simulator)"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" loading={act.busy} disabled={internal.trim().length < 10 || vendor.trim().length < 5} onClick={act.fire}>Block payment</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="Internal reason" required hint="Internal only (DEC-19). At least 10 characters."><Textarea rows={2} value={internal} onChange={(e) => setInternal(e.target.value)} /></Field>
        <Field label="Reason shown to the vendor" required hint="Vendor-safe wording."><Textarea rows={2} value={vendor} onChange={(e) => setVendor(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ advance, payment, history
function AdvanceCard({ a, total, adjusted }: { a: AdvanceInfo; total: number | null; adjusted: number | null }) {
  return (
    <Card title="Advance adjustment (3WM-06)" actions={<Badge tone={a.outstanding > 0 ? 'warn' : 'neutral'}>{a.outstanding > 0 ? `${fmtMoney(a.outstanding, true)} unadjusted` : 'Fully adjusted'}</Badge>}>
      <div className="stack">
        <ul className="list-plain stack-sm">{a.advances.map((x) => (
          <li key={x.id} className="row between"><span><Ref to={`/advances/${x.id}`}>{x.adv_no}</Ref> <span className="small subtle">{x.basis}</span></span><span className="small">{fmtMoney(x.amount, true)} · adjusted {fmtMoney(x.adjusted, true)} · <strong>outstanding {fmtMoney(x.outstanding, true)}</strong></span></li>
        ))}</ul>
        <KV items={[['Invoice total', fmtMoney(total)], ['Advance to adjust', fmtMoney(a.proposed_adjustment)], ['Balance payable', <strong>{fmtMoney(a.balance_payable)}</strong>], ['Adjusted by SAP', adjusted != null ? fmtMoney(adjusted) : 'Not yet cleared']]} />
        <p className="small muted" style={{ margin: 0 }}>SAP clears the advance when it pays the invoice; the unadjusted amount is reported in the advance register.</p>
      </div>
    </Card>
  );
}

function PaymentCard({ d }: { d: Detail }) {
  return (
    <Card title="SAP posting and payment" actions={d.status === 'Payment released' ? <a className="btn btn--secondary btn--sm" href={downloadUrl(`/payments/invoices/${d.id}/advice.pdf`)} target="_blank" rel="noreferrer">Payment advice</a> : undefined}>
      <KV items={[['SAP document', d.sap_doc_no], ['Payment due', fmtDate(d.due_date)], ['Paid on', fmtDate(d.paid_at)], ['Payment ref', d.payment_ref], ...(d.tds != null ? [['TDS', fmtMoney(d.tds)] as [string, ReactNode]] : []), ...(d.retention != null ? [['Retention', fmtMoney(d.retention)] as [string, ReactNode]] : []), ...(d.advance_adjusted != null ? [['Advance adjusted', fmtMoney(d.advance_adjusted)] as [string, ReactNode]] : []), ...(d.deductions?.length ? [['Deductions', d.deductions.map((x) => `${x.label} ${fmtMoney(x.amount)}`).join(', ')] as [string, ReactNode]] : []), ...(d.block_reason_internal && d.status === 'Payment blocked' ? [['Block reason (internal)', d.block_reason_internal] as [string, ReactNode]] : []), ...(d.vendor_reason && d.status === 'Payment blocked' ? [['Shown to vendor', d.vendor_reason] as [string, ReactNode]] : [])]} />
      <p className="small muted" style={{ marginTop: 8 }}>Fields SAP did not provide are not shown (FR-PAY-05).</p>
    </Card>
  );
}

function HistoryTab({ d }: { d: Detail }) {
  const rows = useMemo(() => d.events, [d.events]);
  return (
    <div className="split">
      <Card title="Status timeline">
        <ol className="timeline">
          {rows.map((e) => (
            <li key={e.id}>
              <span className="timeline__dot" data-tone={/Exception|Rejected|blocked/i.test(e.title) ? 'bad' : /approved|Matched|released|Posted|Parked/i.test(e.title) ? 'ok' : undefined} aria-hidden />
              <div className="timeline__title">{e.title}</div>
              <div className="timeline__meta">{e.user_name ?? 'System'} · {fmtDateTime(e.created_at)}{e.vendor_visible ? '' : ' · internal'}</div>
              {e.note && <div className="timeline__body">{e.note}</div>}
            </li>
          ))}
        </ol>
      </Card>
      <Card title="Corrections history" actions={<span className="small muted">FR-INV-06</span>}>
        {d.corrections.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No field was corrected. Accuracy {d.accuracy.accuracy == null ? '—' : fmtPct(d.accuracy.accuracy)} (KPI-10).</p> : (
          <ol className="timeline">
            {d.corrections.map((c) => (
              <li key={c.id}>
                <span className="timeline__dot" data-tone="warn" aria-hidden />
                <div className="timeline__title">{c.label}</div>
                <div className="timeline__meta">{c.user_name} · {fmtDateTime(c.created_at)}</div>
                <div className="timeline__body"><s className="subtle">{c.old_value ?? 'not found'}</s> → <strong>{c.new_value ?? 'empty'}</strong><br />Reason: {c.reason}</div>
              </li>
            ))}
          </ol>
        )}
        {d.final && <p className="small muted" style={{ marginTop: 10 }}>A final record (values, match result and exceptions) is stored with the invoice and is read-only after release to SAP.</p>}
      </Card>
    </div>
  );
}
