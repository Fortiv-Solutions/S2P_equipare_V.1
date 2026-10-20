import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Pencil, Plus, Search, Send, Trash2, UserPlus, XCircle, ShieldAlert, Paperclip } from 'lucide-react';
import { api, ApiError, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtLakh, plural } from '@/lib/format';
import { Badge, Button, Callout, Card, DecisionTag, Empty, KV, LoadingBlock, PageHeader, Priority, Ref, Segmented, SimBadge, Status } from '@/components/ui';
import { Checkbox, ErrorSummary, Field, Input, Select, Textarea, fieldError } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';
import { AttachmentList } from '@/components/Attachments';
import { TrackChain } from '@/components/TrackChain';
import { fromLocalInput, KindBadge, rfqChain, toLocalInput, type Excluded, type RfqDetail, type RfqLine, type SuggestedVendor } from './shared';

const inv = [['rfq'], ['pr']];

/** SCR-RFQ-01 — RFQ builder for a Draft: lines, suggested vendors with reasons, terms, attachments, closing date. */
export default function RfqBuilder({ r }: { r: RfqDetail }) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'cancel' | 'addLines' | 'addVendor' | null>(null);
  const [editLine, setEditLine] = useState<RfqLine | null>(null);
  const cancel = useAction((reason: string) => api.post(`/rfq/rfqs/${r.id}/cancel`, { reason }), { success: `Draft ${r.rfq_no} cancelled`, invalidate: inv });
  const activeLines = r.lines.filter((l) => l.status !== 'Removed');
  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/rfqs">RFQs</Link><span>/</span><span className="mono">{r.rfq_no}</span></>} screen="SCR-RFQ-01"
        title={r.title} badges={<><Status value={r.status} /><KindBadge kind={r.kind} />{r.priority !== 'Normal' && <Priority value={r.priority} />}</>}
        sub={<>Build the enquiry, choose vendors and publish. {r.parent && <>Re-float of <Ref to={`/rfqs/${r.parent.id}`}>{r.parent.rfq_no}</Ref>. </>}{r.opportunity && <>Sourcing for ARC opportunity on <span className="mono">{r.opportunity.material_code}</span>.</>}</>}
        actions={<>
          <a className="btn btn--secondary" href={downloadUrl(`/rfq/rfqs/${r.id}/pdf`, { inline: 1 })} target="_blank" rel="noreferrer"><Download size={16} /> Preview PDF</a>
          <Button variant="danger" icon={<XCircle />} onClick={() => setDialog('cancel')}>Cancel draft</Button>
        </>}
      />
      <Card className="no-print"><TrackChain steps={rfqChain(r)} compact /></Card>
      <div style={{ height: 16 }} />
      <div className="split">
        <div className="stack">
          <LinesCard r={r} lines={activeLines} onEdit={setEditLine} onAdd={() => setDialog('addLines')} />
          <VendorsCard r={r} onAdd={() => setDialog('addVendor')} />
          <TermsCard r={r} />
          <Card title="RFQ attachments" actions={<span className="small muted">Drawings, specifications, catalogues, site notes (FR-RFQ-10)</span>}>
            <AttachmentList ownerType="rfq" ownerId={r.id} canUpload uploadLabel="Drawing / specification" />
          </Card>
        </div>
        <div className="stack">
          <PublishCard r={r} />
          <Card title="Summary">
            <KV items={[
              ['Buyer', r.buyer_name], ['Estimated value', fmtLakh(r.est_value)], ['Category minimum', `${r.min_vendors} vendors (${r.categories.map((c) => c.code).join(', ') || '—'})`],
              ['Quotations', r.sealed ? <>Sealed until close <DecisionTag id="Q 18.1" /></> : 'Open (not sealed)'],
              ['Reminders', r.reminder_schedule ? <>{r.reminder_schedule.before_days.join(', ')} day(s) before, {r.reminder_schedule.after_days.join(', ')} after <DecisionTag id="Q 7.2" /></> : '—'],
              ['SAP RFQ (INT-M05)', <>Reference only <DecisionTag id="DEC-04" /></>],
              ['Created', fmtDateTime(r.created_at)],
            ]} />
            <ContractSnapshot r={r} />
          </Card>
        </div>
      </div>
      <ReasonDialog open={dialog === 'cancel'} onClose={() => setDialog(null)} title={`Cancel draft ${r.rfq_no}`} variant="danger" confirmLabel="Cancel draft" sub="PR lines go back to Route decided so they can join another RFQ." onSubmit={async (reason) => { await cancel.run(reason); navigate('/rfqs'); }} />
      <AddLinesDialog r={r} open={dialog === 'addLines'} onClose={() => setDialog(null)} />
      <AddVendorDialog r={r} open={dialog === 'addVendor'} onClose={() => setDialog(null)} />
      {editLine && <LineDialog r={r} line={editLine} onClose={() => setEditLine(null)} />}
    </>
  );
}

export function ContractSnapshot({ r }: { r: RfqDetail }) {
  const snap = r.no_contract_snapshot ?? [];
  if (!snap.length) return null;
  const found = snap.filter((s) => s.contract_no);
  return (
    <p className="small muted" style={{ marginTop: 12 }}>
      {found.length ? <>Contract found at creation: {found.map((s) => `line ${s.rfq_line_no} ${s.contract_type} ${s.contract_no}`).join('; ')} (off-contract route recorded).</> : <>No valid ARC / OA / FDS covered these lines when the RFQ was created ({fmtDateTime(snap[0].checked_at)}) — WF-03 record.</>}
    </p>
  );
}

function LinesCard({ r, lines, onEdit, onAdd }: { r: RfqDetail; lines: RfqLine[]; onEdit: (l: RfqLine) => void; onAdd: () => void }) {
  const remove = useAction((id: number) => api.del(`/rfq/rfqs/${r.id}/lines/${id}`), { success: 'Line removed; its PR line is back to Route decided', invalidate: inv });
  const [flag, setFlag] = useState<{ line: RfqLine; action: 'keep' | 'remove' } | null>(null);
  const resolve = useAction((reason: string) => api.post(`/rfq/rfqs/${r.id}/lines/${flag!.line.id}/flag`, { action: flag!.action, reason }), { success: (x: any) => (x.status === 'Removed' ? 'Flagged line removed' : 'Line kept with your reason'), invalidate: inv });
  const prob = r.publish_problems;
  return (
    <Card title={<div className="row-wrap"><h2>Lines</h2><span className="small muted">{plural(lines.length, 'line')}</span></div>} actions={r.kind !== 'ARC' && <Button size="sm" icon={<Plus />} onClick={onAdd}>Add PR lines</Button>} flush>
      {lines.length === 0 ? <Empty title="No lines">Add PR lines with a decided RFQ route.</Empty> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Line</th><th>Material</th><th className="num">Qty</th><th>Required</th><th>Quote due</th><th>Ship-to</th><th>GST</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => {
                const errs = Object.entries(prob).filter(([k]) => k.startsWith(`lines.${l.line_no}.`)).map(([, v]) => v);
                return (
                  <tr key={l.id}>
                    <td className="mono">{l.line_no}</td>
                    <td style={{ minWidth: 220 }}>
                      <div style={{ fontWeight: 600 }}>{l.description}</div>
                      <div className="small subtle"><span className="mono">{l.material_code}</span>{l.pr_ref && <> · PR <Ref to={`/pr/${l.pr_line_id}`}>{l.pr_ref}</Ref></>}{l.files ? <> · <Paperclip size={11} /> {l.files}</> : null}</div>
                      {l.status === 'Flagged' && (
                        <div className="stack-sm" style={{ marginTop: 6 }}>
                          <span className="small" style={{ color: 'var(--bad)', fontWeight: 600 }}><ShieldAlert size={12} /> {l.flag_reason}</span>
                          <div className="row"><Button size="sm" onClick={() => setFlag({ line: l, action: 'keep' })}>Keep with reason</Button><Button size="sm" variant="danger" onClick={() => setFlag({ line: l, action: 'remove' })}>Remove line</Button></div>
                        </div>
                      )}
                      {errs.length > 0 && <div className="small" style={{ color: 'var(--bad)' }}>{errs.join('; ')}</div>}
                    </td>
                    <td className="num nowrap">{l.qty} {l.uom}</td>
                    <td className="nowrap">{fmtDate(l.required_date)}</td>
                    <td className="nowrap small">{fmtDateTime(l.due_at)}</td>
                    <td className="small" style={{ minWidth: 160, maxWidth: 240 }}><strong>{l.plant}</strong> · {l.ship_to ?? <span style={{ color: 'var(--bad)' }}>missing</span>}</td>
                    <td>{l.gst_rate != null ? `${l.gst_rate}%` : '—'}</td>
                    <td className="nowrap">
                      <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} onClick={() => onEdit(l)}>Edit line {l.line_no}</Button>
                      {r.kind !== 'ARC' && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} loading={remove.busy} onClick={() => remove.fire(l.id)}>Remove line {l.line_no}</Button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ReasonDialog open={!!flag} onClose={() => setFlag(null)} title={flag?.action === 'keep' ? `Keep line ${flag?.line.line_no} in the RFQ` : `Remove line ${flag?.line.line_no}`} variant={flag?.action === 'remove' ? 'danger' : 'primary'}
        confirmLabel={flag?.action === 'keep' ? 'Keep line' : 'Remove line'} sub="The PR line was cancelled or closed in SAP while in this RFQ." onSubmit={(x) => resolve.run(x)} />
    </Card>
  );
}

function LineDialog({ r, line, onClose }: { r: RfqDetail; line: RfqLine; onClose: () => void }) {
  const plants = useQuery<{ code: string; name: string; ship_to_address: string }[]>({ queryKey: ['rfq', 'plants'], queryFn: () => api.get('/rfq/plants') });
  const [f, setF] = useState({
    description: line.description, qty: String(line.qty), required_date: line.required_date ?? '', due_at: toLocalInput(line.due_at), plant: line.plant ?? '', ship_to: line.ship_to ?? '',
    gst_rate: line.gst_rate == null ? '' : String(line.gst_rate), valuation_type: line.valuation_type ?? '', transport_req: line.transport_req ?? '', specs: line.specs ?? '', reason: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useAction(() => api.put(`/rfq/rfqs/${r.id}/lines/${line.id}`, {
    description: f.description, qty: Number(f.qty), required_date: f.required_date || null, due_at: f.due_at ? fromLocalInput(f.due_at) : null, plant: f.plant,
    ship_to: f.ship_to, gst_rate: f.gst_rate === '' ? null : Number(f.gst_rate), valuation_type: f.valuation_type, transport_req: f.transport_req, specs: f.specs, reason: f.reason || undefined,
  }), { success: `Line ${line.line_no} saved`, invalidate: inv, onSuccess: onClose, silentError: true });
  const af = line.autofill;
  const changed = (k: 'gst_rate' | 'valuation_type' | 'ship_to' | 'transport_req' | 'plant') => af && String(af[k] ?? '') !== String(k === 'gst_rate' ? f.gst_rate : f[k]);
  const hint = (k: 'gst_rate' | 'valuation_type' | 'ship_to' | 'transport_req' | 'plant') => (af ? (changed(k) ? `Master value: ${af[k] ?? '—'} — your change is audited` : 'Auto-filled from master data') : undefined);
  return (
    <Modal open onClose={onClose} wide title={`Line ${line.line_no} — ${line.material_code ?? ''}`} sub={line.pr_ref ? `PR ${line.pr_ref}${line.requisitioner ? ` · ${line.requisitioner}` : ''}` : 'Annual-rate line'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={save.busy} onClick={save.fire}>Save line</Button></>}>
      <div className="stack">
        <ErrorSummary error={save.error} />
        <div className="form-grid">
          <Field label="Description" required className="span-2" error={fieldError(save.error, 'description')}><Input value={f.description} onChange={set('description')} /></Field>
          <Field label={`Quantity (${line.uom})`} required error={fieldError(save.error, 'qty')}><Input type="number" min={0} value={f.qty} onChange={set('qty')} /></Field>
          <Field label="Required date" required><Input type="date" value={f.required_date} onChange={set('required_date')} /></Field>
          <Field label="Quote due (this line)" hint={`On or before closing ${fmtDateTime(r.closing_at)}`} error={fieldError(save.error, 'due_at')}><Input type="datetime-local" value={f.due_at} onChange={set('due_at')} /></Field>
          <Field label="Plant" required hint={hint('plant')}><Select value={f.plant} onChange={set('plant')} options={(plants.data ?? []).map((p) => ({ value: p.code, label: `${p.code} — ${p.name}` }))} /></Field>
          <Field label="Ship-to address" required className="span-2" hint={hint('ship_to')}><Textarea rows={2} value={f.ship_to} onChange={set('ship_to')} /></Field>
          <Field label="GST rate" hint={hint('gst_rate')} error={fieldError(save.error, 'gst_rate')}><Select value={f.gst_rate} onChange={set('gst_rate')} placeholder="Not set" options={['0', '5', '12', '18', '28'].map((x) => ({ value: x, label: `${x}%` }))} /></Field>
          <Field label="Valuation type" hint={hint('valuation_type')}><Input value={f.valuation_type} onChange={set('valuation_type')} /></Field>
          <Field label="Transport requirement" className="span-2" hint={hint('transport_req')}><Input value={f.transport_req} onChange={set('transport_req')} /></Field>
          <Field label="Specification / notes to vendors" className="span-2"><Textarea rows={3} value={f.specs} onChange={set('specs')} /></Field>
          <Field label="Reason for change" className="span-2" hint="Optional; recommended when you override a master-data value."><Input value={f.reason} onChange={set('reason')} maxLength={500} /></Field>
        </div>
        <div>
          <h3 style={{ marginBottom: 8 }}>Line attachments</h3>
          <AttachmentList ownerType="rfq_line" ownerId={line.id} canUpload uploadLabel="Drawing / photo / site note" camera />
        </div>
      </div>
    </Modal>
  );
}

function AddLinesDialog({ r, open, onClose }: { r: RfqDetail; open: boolean; onClose: () => void }) {
  const q = useQuery<{ id: number; ref: string; description: string; qty: number; uom: string; plant: string; route: string; priority: string }[]>({
    queryKey: ['pr', 'lines', 'mine', { status: 'Route decided' }], queryFn: () => api.get('/pr/lines', { view: 'mine', status: 'Route decided' }), enabled: open,
  });
  const [sel, setSel] = useState<number[]>([]);
  useEffect(() => { if (open) setSel([]); }, [open]);
  const add = useAction(() => api.post(`/rfq/rfqs/${r.id}/lines`, { pr_line_ids: sel }), { success: `${plural(sel.length, 'line')} added`, invalidate: inv, onSuccess: onClose, silentError: true });
  const rows = (q.data ?? []).filter((l) => ['RFQ', 'Urgent/BD', 'Class 1', 'Capex', 'Service'].includes(l.route));
  return (
    <Modal open={open} onClose={onClose} wide title="Add PR lines" sub="Your lines with a decided RFQ route that are not in another RFQ."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" disabled={!sel.length} loading={add.busy} onClick={add.fire}>Add {sel.length || ''} line{sel.length === 1 ? '' : 's'}</Button></>}>
      <ErrorSummary error={add.error} />
      {q.isLoading ? <LoadingBlock rows={3} /> : rows.length === 0 ? <Empty title="No lines ready">Decide the route on more PR lines in the workbench first.</Empty> : (
        <ul className="list-plain stack-sm">
          {rows.map((l) => (
            <li key={l.id}><Checkbox checked={sel.includes(l.id)} onChange={() => setSel((s) => (s.includes(l.id) ? s.filter((x) => x !== l.id) : [...s, l.id]))}
              label={<span><span className="mono">{l.ref}</span> · {l.description} · {l.qty} {l.uom} · {l.plant} {l.priority !== 'Normal' && <Priority value={l.priority} />}</span>} /></li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ReasonChips({ reasons }: { reasons: { label: string; points: number }[] }) {
  return <div className="row-wrap" style={{ gap: 4, marginTop: 4 }}>{reasons.map((x, i) => <span key={i} className="chip" title={`${x.points} points`}>{x.label}</span>)}</div>;
}

function VendorsCard({ r, onAdd }: { r: RfqDetail; onAdd: () => void }) {
  const s = useQuery<{ vendors: SuggestedVendor[]; excluded: Excluded[] }>({ queryKey: ['rfq', 'suggestions', r.id, r.lines.length], queryFn: () => api.get(`/rfq/rfqs/${r.id}/suggestions`) });
  const invite = useAction((vendor_id: number) => api.post(`/rfq/rfqs/${r.id}/invitations`, { vendor_id }), { success: 'Vendor invited', invalidate: inv });
  const remove = useAction((id: number) => api.del(`/rfq/rfqs/${r.id}/invitations/${id}`), { success: 'Vendor removed', invalidate: inv });
  const [justify, setJustify] = useState<{ id: number; name: string } | null>(null);
  const saveJust = useAction((j: string) => api.put(`/rfq/rfqs/${r.id}/invitations/${justify!.id}`, { justification: j }), { success: 'Justification saved', invalidate: inv });
  const [showEx, setShowEx] = useState(false);
  const invitedIds = new Set(r.invitations.map((i) => i.vendor_id));
  const open = (s.data?.vendors ?? []).filter((v) => !invitedIds.has(v.vendor_id));
  const below = r.invitations.length < r.min_vendors;
  return (
    <Card title={<div className="row-wrap"><h2>Vendors</h2><Badge tone={below ? 'warn' : 'ok'}>{r.invitations.length} of {r.min_vendors} minimum</Badge></div>} actions={<Button size="sm" icon={<UserPlus />} onClick={onAdd}>Add another vendor</Button>}>
      <div className="stack">
        {r.invitations.length === 0 ? <Callout tone="info">No vendors yet. Invite from the suggestions below.</Callout> : (
          <ul className="list-plain stack-sm">
            {r.invitations.map((i) => (
              <li key={i.id} className="row between" style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', alignItems: 'flex-start' }}>
                <div className="grow">
                  <div className="row-wrap"><strong>{i.vendor_name}</strong><span className="mono small subtle">{i.sap_code ?? 'No SAP code'}</span>{i.suggested ? <Badge tone="ok" plain>Suggested · {i.suggest_reasons?.score ?? 0} pts</Badge> : <Badge tone="warn">Not suggested</Badge>}</div>
                  <div className="small muted">{i.contact_name ?? '—'} · {i.contact_email ?? <span style={{ color: 'var(--bad)' }}>no contact e-mail — invitation will fail</span>}</div>
                  {!i.suggested && (
                    <div className="small" style={{ marginTop: 4 }}>
                      {i.added_justification ? <>Justification: {i.added_justification}</> : <span style={{ color: 'var(--bad)', fontWeight: 600 }}>Justification required before publishing</span>}{' '}
                      <button className="btn btn--ghost btn--sm" onClick={() => setJustify({ id: i.id, name: i.vendor_name })}>{i.added_justification ? 'Change' : 'Add justification'}</button>
                    </div>
                  )}
                </div>
                <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => remove.fire(i.id)}>Remove {i.vendor_name}</Button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <h3 style={{ marginBottom: 6 }}>Suggested by rules <span className="small muted" style={{ fontWeight: 400 }}>— category, sub-category, brand, plant region, participation, performance, contracts (FR-RFQ-02)</span></h3>
          {s.isLoading ? <LoadingBlock rows={3} /> : open.length === 0 ? <p className="small muted">{(s.data?.vendors.length ?? 0) ? 'All suggested vendors are invited.' : 'No approved vendor capability matches these lines.'}</p> : (
            <ul className="list-plain stack-sm">
              {open.map((v) => (
                <li key={v.vendor_id} className="row between" style={{ padding: '8px 10px', background: 'var(--surface-sunk)', borderRadius: 'var(--r-sm)', alignItems: 'flex-start' }}>
                  <div className="grow">
                    <div className="row-wrap"><strong>{v.name}</strong><span className="mono small subtle">{v.sap_code}</span><span className="small muted">{v.city}</span><Badge tone="deep">{v.score} pts</Badge><span className="small muted">lines {v.lines.join(', ')}</span></div>
                    <ReasonChips reasons={v.reasons} />
                  </div>
                  <Button size="sm" variant="primary" icon={<Plus />} loading={invite.busy} onClick={() => invite.fire(v.vendor_id)}>Invite</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {(s.data?.excluded.length ?? 0) > 0 && (
          <div>
            <button className="btn btn--ghost btn--sm" onClick={() => setShowEx(!showEx)}>{showEx ? 'Hide' : 'Show'} {plural(s.data!.excluded.length, 'excluded vendor')}</button>
            {showEx && <ul className="list-plain stack-sm small" style={{ marginTop: 6 }}>{s.data!.excluded.map((e) => <li key={e.vendor_id}><strong>{e.name}</strong> <span className="mono subtle">{e.sap_code}</span> — <span style={{ color: 'var(--bad)' }}>{e.reasons.join('; ')}</span></li>)}</ul>}
          </div>
        )}
      </div>
      <ReasonDialog open={!!justify} onClose={() => setJustify(null)} title={`Why invite ${justify?.name}?`} label="Justification" confirmLabel="Save justification" sub="Recorded with the invitation and shown to approvers (FR-RFQ-03)." onSubmit={(j) => saveJust.run(j)} />
    </Card>
  );
}

function AddVendorDialog({ r, open, onClose }: { r: RfqDetail; open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<number | null>(null);
  const [just, setJust] = useState('');
  useEffect(() => { if (open) { setQ(''); setPick(null); setJust(''); } }, [open]);
  const res = useQuery<{ id: number; name: string; sap_code: string | null; city: string | null; suggested: boolean; invited: boolean; ineligible: string[]; capabilities: string[] }[]>({
    queryKey: ['rfq', 'vendor-search', r.id, q], queryFn: () => api.get(`/rfq/rfqs/${r.id}/vendor-search`, { q }), enabled: open && q.trim().length >= 2,
  });
  const chosen = res.data?.find((v) => v.id === pick);
  const add = useAction(() => api.post(`/rfq/rfqs/${r.id}/invitations`, { vendor_id: pick, justification: just || null }), { success: `${chosen?.name ?? 'Vendor'} added`, invalidate: inv, onSuccess: onClose, silentError: true });
  return (
    <Modal open={open} onClose={onClose} wide title="Add another vendor" sub="Vendors the rules did not suggest need a justification (FR-RFQ-03). Blocked vendors and vendors with expired mandatory KYC cannot be invited."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={add.busy} disabled={!chosen || chosen.invited || chosen.ineligible.length > 0 || (!chosen.suggested && just.trim().length < 10)} onClick={add.fire}>Add vendor</Button></>}>
      <div className="stack">
        <ErrorSummary error={add.error} />
        <Field label="Search vendors" hint="Name, SAP code or city"><Input value={q} onChange={(e) => setQ(e.target.value)} data-autofocus placeholder="e.g. Kranti or 100108" /></Field>
        {q.trim().length >= 2 && (res.isLoading ? <LoadingBlock rows={2} /> : !res.data?.length ? <p className="small muted">No vendor matches “{q}”.</p> : (
          <ul className="list-plain stack-sm" style={{ maxHeight: 260, overflow: 'auto' }}>
            {res.data.map((v) => (
              <li key={v.id}>
                <label className="row" style={{ padding: '6px 8px', border: `1px solid ${pick === v.id ? 'var(--primary-600)' : 'var(--line)'}`, borderRadius: 'var(--r-sm)', cursor: v.invited || v.ineligible.length ? 'not-allowed' : 'pointer', opacity: v.invited || v.ineligible.length ? 0.65 : 1, alignItems: 'flex-start' }}>
                  <input type="radio" name="vendor" disabled={v.invited || v.ineligible.length > 0} checked={pick === v.id} onChange={() => setPick(v.id)} />
                  <span className="grow">
                    <strong>{v.name}</strong> <span className="mono small subtle">{v.sap_code ?? 'No SAP code'}</span> <span className="small muted">{v.city}</span>{' '}
                    {v.invited ? <Badge>Already on RFQ</Badge> : v.suggested ? <Badge tone="ok" plain>Suggested</Badge> : null}
                    <div className="small muted">{v.capabilities.join(' · ') || 'No approved capability'}</div>
                    {v.ineligible.length > 0 && <div className="small" style={{ color: 'var(--bad)' }}>{v.ineligible.join('; ')}</div>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ))}
        {chosen && !chosen.suggested && (
          <Field label="Justification" required hint="At least 10 characters. Visible to approvers; publishing is blocked without it." error={fieldError(add.error, 'justification')}>
            <Textarea rows={3} value={just} onChange={(e) => setJust(e.target.value)} maxLength={500} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function TermsCard({ r }: { r: RfqDetail }) {
  const init = useMemo(() => ({ title: r.title, closing_at: toLocalInput(r.closing_at), delivery_terms: r.delivery_terms ?? 'FOR', payment_terms: r.payment_terms ?? '', warranty: r.warranty ?? '', packing: r.packing ?? '', documents_required: r.documents_required ?? '', standard_terms: r.standard_terms ?? '', ship_to: r.ship_to ?? '' }), [r]);
  const [f, setF] = useState(init);
  useEffect(() => setF(init), [init]);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useAction(() => api.put(`/rfq/rfqs/${r.id}`, { ...f, closing_at: f.closing_at ? fromLocalInput(f.closing_at) : undefined }), { success: 'Terms saved', invalidate: inv, silentError: true });
  const p = r.publish_problems;
  const err = (k: string) => fieldError(save.error, k) ?? p[k] ?? null;
  return (
    <Card title="Terms and closing date" actions={<span className="small muted">FR-RFQ-05 — all fields are required to publish</span>}
      foot={<div className="row between"><span className="small muted">{dirty ? 'Unsaved changes' : 'Saved'}</span><Button variant="deep" loading={save.busy} disabled={!dirty} onClick={save.fire}>Save terms</Button></div>}>
      <div className="stack">
        <ErrorSummary error={save.error} />
        <div className="form-grid">
          <Field label="Title" required className="span-2" error={err('title')}><Input value={f.title} onChange={set('title')} maxLength={200} /></Field>
          <Field label="Closing date and time" required error={err('closing_at')}><Input type="datetime-local" value={f.closing_at} onChange={set('closing_at')} /></Field>
          <Field label="Delivery terms" required error={err('delivery_terms')}><Segmented label="Delivery terms" value={f.delivery_terms as 'FOR' | 'Ex-Works'} onChange={(v) => setF((x) => ({ ...x, delivery_terms: v }))} options={[{ id: 'FOR', label: 'FOR (delivered)' }, { id: 'Ex-Works', label: 'Ex-Works' }]} /></Field>
          <Field label="Payment terms"><Input value={f.payment_terms} onChange={set('payment_terms')} /></Field>
          <Field label="Warranty" required error={err('warranty')}><Input value={f.warranty} onChange={set('warranty')} /></Field>
          <Field label="Packing" required className="span-2" error={err('packing')}><Input value={f.packing} onChange={set('packing')} /></Field>
          <Field label="Documents required" required className="span-2" error={err('documents_required')}><Textarea rows={2} value={f.documents_required} onChange={set('documents_required')} /></Field>
          <Field label="Standard terms" required className="span-2" error={err('standard_terms')}><Textarea rows={3} value={f.standard_terms} onChange={set('standard_terms')} /></Field>
          <Field label="Default ship-to (header)" className="span-2" hint="Each line carries its own ship-to from the plant master."><Textarea rows={2} value={f.ship_to} onChange={set('ship_to')} /></Field>
        </div>
      </div>
    </Card>
  );
}

function PublishCard({ r }: { r: RfqDetail }) {
  const { me } = useAuth();
  const [reason, setReason] = useState(r.exception_reason ?? '');
  const publish = useAction(() => api.post<{ status: string; approvals: string[] }>(`/rfq/rfqs/${r.id}/publish`, { exception_reason: reason || null }), {
    success: (x) => (x.status === 'Published' ? `RFQ ${r.rfq_no} published` : `RFQ ${r.rfq_no} sent for exception approval (${x.approvals.join(', ')})`), invalidate: inv, silentError: true,
  });
  const problems = Object.values(r.publish_problems);
  const below = r.invitations.length < r.min_vendors;
  const apiErr = publish.error instanceof ApiError ? publish.error : null;
  const checks: [string, boolean][] = [
    ['At least one line', r.lines.some((l) => l.status !== 'Removed')],
    ['At least one vendor invited', r.invitations.length > 0],
    ['Closing date in the future', new Date(r.closing_at).getTime() > Date.now()],
    ['All RFQ-05 fields filled', !problems.some((p) => /required/.test(p))],
    ['Non-suggested vendors justified', !Object.keys(r.publish_problems).some((k) => k.endsWith('.justification'))],
    ['No flagged lines', !r.lines.some((l) => l.status === 'Flagged')],
  ];
  return (
    <Card title="Publish">
      <div className="stack">
        <ul className="list-plain stack-sm small">
          {checks.map(([label, ok]) => <li key={label} className="row"><span className="dot" style={{ color: ok ? 'var(--ok)' : 'var(--bad)' }} /> <span style={{ fontWeight: ok ? 400 : 600 }}>{label}</span></li>)}
        </ul>
        {problems.length > 0 && <Callout tone="warn" title="Fix before publishing"><ul style={{ margin: 0, paddingLeft: 16 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul></Callout>}
        {below && (
          <>
            <Callout tone="decision" title={`Category minimum is ${r.min_vendors} vendors`}>{r.invitations.length} invited. Invite more, or justify a {r.invitations.length === 1 ? 'single' : 'limited'}-source RFQ — it goes to the Procurement Manager for approval and publishes on approval (FR-RFQ-11).</Callout>
            <Field label="Limited-source justification" required error={apiErr?.fields?.exception_reason ?? null}><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
          </>
        )}
        {apiErr && <ErrorSummary error={apiErr} />}
        <Button variant={below ? 'decision' : 'primary'} icon={<Send />} loading={publish.busy} disabled={problems.length > 0 || (below && reason.trim().length < 10)} onClick={publish.fire}>
          {below ? 'Send for exception approval' : 'Publish RFQ'}
        </Button>
        <p className="small muted">Publishing sends invitations in-app and by e-mail <SimBadge>Simulated e-mail</SimBadge> to {plural(r.invitations.length, 'vendor')}. {me?.name ?? 'You'} stay the owner.</p>
      </div>
    </Card>
  );
}

export { Search };
