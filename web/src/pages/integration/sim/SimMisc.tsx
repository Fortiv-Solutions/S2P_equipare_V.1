/** Simulator tabs: purchase requisitions, vendors, outline agreements, stock, outage and failure injection. */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardPlus, Building2, FileSignature, Boxes, Power, Zap, Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '@/lib/format';
import { Badge, Button, Callout, Empty, Loader, Ref, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { ErrorSummary, Field, Input, Select } from '@/components/forms';
import { SyncResult } from '../shared';
import { SIM_INVALIDATE, SimPanel, focusStyle, plusDays, useFocusScroll, useLookups, type SimResult } from './common';

// ====================================================================== purchase requisitions
interface PrDoc { pr_no: string; requisitioner_email: string; department: string; changed_at: string; items: { item: number; material_code: string; description: string; qty: number; uom: string; plant: string; required_date: string; priority: string; platform: { id: number; status: string; buyer: string | null } | null }[] }
interface PrItem { material_code: string; qty: string; plant: string; required_date: string; priority: string }
const blank = (): PrItem => ({ material_code: '', qty: '', plant: '', required_date: plusDays(10), priority: 'Normal' });

export function PrTab() {
  const lk = useLookups();
  const list = useQuery<PrDoc[]>({ queryKey: ['sim', 'prs'], queryFn: () => api.get('/sap/sim/prs') });
  const [req, setReq] = useState('');
  const [items, setItems] = useState<PrItem[]>([blank()]);
  const [last, setLast] = useState<SimResult | null>(null);
  const act = useAction(() => api.post<SimResult & { pr_no: string }>('/sap/sim/pr', {
    requisitioner_email: req, items: items.map((i) => ({ material_code: i.material_code, qty: Number(i.qty), plant: i.plant, required_date: i.required_date, priority: i.priority })),
  }), { success: (r) => `SAP simulator raised PR ${r.pr_no}${r.sync?.synced ? ' and the platform synced it' : ''}`, invalidate: SIM_INVALIDATE, onSuccess: (r) => { setLast(r); setItems([blank()]); }, silentError: true });
  const set = (i: number, k: keyof PrItem, v: string) => setItems(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const cols: Column<PrDoc['items'][number] & { pr_no: string; requisitioner_email: string }>[] = useMemo(() => [
    { key: 'pr_no', header: 'PR / item', render: (r) => <span className="mono">{r.pr_no}/{r.item}</span>, value: (r) => `${r.pr_no}/${r.item}` },
    { key: 'description', header: 'Material' }, { key: 'qty', header: 'Qty', align: 'right', render: (r) => `${r.qty} ${r.uom}`, value: (r) => r.qty },
    { key: 'plant', header: 'Plant' }, { key: 'requisitioner_email', header: 'Requisitioner' }, { key: 'required_date', header: 'Required', render: (r) => fmtDate(r.required_date) },
    { key: 'platform', header: 'Platform', render: (r) => (r.platform ? <><Ref to={`/pr/${r.platform.id}`}>{r.platform.status}</Ref>{r.platform.buyer && <span className="small muted"> · {r.platform.buyer}</span>}</> : <span className="subtle">Not synced</span>), value: (r) => r.platform?.status ?? '' },
  ], []);
  const rows = (list.data ?? []).flatMap((d) => d.items.map((i) => ({ ...i, pr_no: d.pr_no, requisitioner_email: d.requisitioner_email })));
  return (
    <div className="stack">
      <SyncResult sync={last?.sync}>{last?.pr_no && <p>Purchase requisition <span className="mono">{last.pr_no}</span> raised in SAP.</p>}</SyncResult>
      <SimPanel title="Raise a purchase requisition in SAP">
        <div className="stack">
          <ErrorSummary error={act.error} />
          <Field label="Requisitioner" required><Select value={req} onChange={(e) => setReq(e.target.value)} placeholder="Choose the requisitioner" options={(lk.data?.requisitioners ?? []).map((r) => ({ value: r.email, label: `${r.name}${r.department ? ` — ${r.department}` : ''}` }))} /></Field>
          {items.map((it, i) => (
            <div key={i} className="form-grid" style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 10 }}>
              <Field label={`Item ${(i + 1) * 10} material`} required className="span-2"><Select value={it.material_code} onChange={(e) => set(i, 'material_code', e.target.value)} placeholder="Choose a material" options={(lk.data?.materials ?? []).map((m) => ({ value: m.code, label: `${m.code} — ${m.description}` }))} /></Field>
              <Field label="Quantity" required><Input type="number" min={0} step="any" value={it.qty} onChange={(e) => set(i, 'qty', e.target.value)} /></Field>
              <Field label="Plant" required><Select value={it.plant} onChange={(e) => set(i, 'plant', e.target.value)} placeholder="Choose a plant" options={(lk.data?.plants ?? []).map((p) => ({ value: p.code, label: `${p.code} — ${p.name}` }))} /></Field>
              <Field label="Required date" required><Input type="date" min={new Date().toISOString().slice(0, 10)} value={it.required_date} onChange={(e) => set(i, 'required_date', e.target.value)} /></Field>
              <Field label="Priority"><Select value={it.priority} onChange={(e) => set(i, 'priority', e.target.value)} options={lk.data?.priorities ?? ['Normal']} /></Field>
              {items.length > 1 && <div className="span-2"><Button size="sm" variant="ghost" icon={<X />} onClick={() => setItems(items.filter((_, j) => j !== i))}>Remove item</Button></div>}
            </div>
          ))}
          <div className="row-wrap between">
            <Button size="sm" icon={<Plus />} onClick={() => setItems([...items, blank()])}>Add item</Button>
            <Button variant="deep" icon={<ClipboardPlus />} loading={act.busy} disabled={!req || items.some((i) => !i.material_code || !(Number(i.qty) > 0) || !i.plant)} onClick={act.fire}>Raise PR in SAP simulator</Button>
          </div>
        </div>
      </SimPanel>
      <SimPanel title="Purchase requisitions in SAP">
        <div style={{ margin: -16 }}><DataTable id="sim-prs" rows={rows} loading={list.isLoading} error={list.error} refetch={list.refetch} rowKey={(r) => `${r.pr_no}/${r.item}`} columns={cols} dense savedViews={false} initialSort={{ key: 'pr_no', dir: 'desc' }}
          mobile={{ title: (r) => <span className="mono">{r.pr_no}/{r.item}</span>, badge: (r) => <Status value={r.platform?.status ?? 'Not synced'} />, meta: (r) => [r.description, `${r.qty} ${r.uom}`, r.plant] }} /></div>
      </SimPanel>
    </div>
  );
}

// ====================================================================== vendors
interface VendorSrc { pending: { id: number; name: string; pan: string | null; gstin: string | null; city: string | null; onboarding_status: string }[]; bank: { id: number; vendor_id: number; vendor_name: string; sap_code: string | null; old_value: string | null; new_value_masked: string | null; status: string; created_at: string }[] }

export function VendorTab({ pre }: { pre: number | null }) {
  const q = useQuery<VendorSrc>({ queryKey: ['sim', 'vendors'], queryFn: () => api.get('/sap/sim/vendors') });
  const [last, setLast] = useState<SimResult | null>(null);
  const create = useAction((id: number) => api.post<SimResult & { sap_code: string }>('/sap/sim/vendor', { vendor_id: id }), { success: (r) => `SAP simulator created vendor ${r.sap_code}`, invalidate: SIM_INVALIDATE, onSuccess: setLast });
  const bank = useAction((c: { vendor_id: number; id: number }) => api.post<SimResult & { change_request_status: string }>(`/sap/sim/vendor/${c.vendor_id}/bank`, { change_request_id: c.id }), { success: (r) => `SAP simulator applied the bank change (request now ${r.change_request_status})`, invalidate: SIM_INVALIDATE, onSuccess: setLast });
  return (
    <div className="stack">
      <SyncResult sync={last?.sync}>{last?.sap_code && <p>SAP vendor code <span className="mono">{last.sap_code}</span> is now linked to the vendor.</p>}</SyncResult>
      <SimPanel title="Create SAP vendor for an onboarding vendor">
        <Loader q={q}>{(d) => d.pending.length === 0 ? <Empty title="No vendor is waiting for a SAP code">Vendors appear here once onboarding is approved (“Pending SAP code”).</Empty> : (
          <div className="stack-sm">{d.pending.map((v) => <VendorRow key={v.id} v={v} focus={pre === v.id} busy={create.busy} onCreate={() => create.fire(v.id)} />)}</div>
        )}</Loader>
      </SimPanel>
      <SimPanel title="Apply an approved bank change in SAP">
        <Loader q={q}>{(d) => d.bank.length === 0 ? <Empty title="No bank change request">Vendor bank change requests appear here after finance approves them.</Empty> : (
          <div className="stack-sm">{d.bank.map((c) => (
            <div key={c.id} className="row between row-wrap" style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 10 }}>
              <div><Link to={`/vendors/${c.vendor_id}`}><strong>{c.vendor_name}</strong></Link> <span className="mono small">{c.sap_code}</span> <Status value={c.status} />
                <div className="small muted">{c.old_value ?? '—'} → <span className="mono">{c.new_value_masked}</span> · requested {fmtDate(c.created_at)}</div></div>
              <Button size="sm" variant="deep" icon={<Building2 />} loading={bank.busy} disabled={c.status === 'Pending'} title={c.status === 'Pending' ? 'Finance must approve the change first' : undefined} onClick={() => bank.fire({ vendor_id: c.vendor_id, id: c.id })}>{c.status === 'Pending' ? 'Awaiting finance approval' : 'Apply in SAP'}</Button>
            </div>
          ))}</div>
        )}</Loader>
      </SimPanel>
    </div>
  );
}
function VendorRow({ v, focus, busy, onCreate }: { v: VendorSrc['pending'][number]; focus: boolean; busy: boolean; onCreate: () => void }) {
  const ref = useFocusScroll(focus);
  const ready = v.onboarding_status === 'Pending SAP code';
  return (
    <div ref={ref} className="row between row-wrap" style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 10, ...focusStyle(focus) }}>
      <div><Link to={`/vendors/${v.id}`}><strong>{v.name}</strong></Link> <Status value={v.onboarding_status} /><div className="small muted mono">{v.gstin} · {v.pan} · {v.city}</div></div>
      <Button size="sm" variant="deep" icon={<Building2 />} loading={busy} disabled={!ready} title={ready ? undefined : 'Onboarding must be approved first'} onClick={onCreate}>{ready ? 'Create SAP vendor' : 'Onboarding not approved yet'}</Button>
    </div>
  );
}

// ====================================================================== outline agreements
interface OaSrc { id: number; contract_no: string; type: string; title: string | null; vendor_name: string; sap_code: string | null; valid_from: string | null; valid_to: string | null; value_cap: number | null; items: number }
export function OaTab({ pre }: { pre: number | null }) {
  const q = useQuery<OaSrc[]>({ queryKey: ['sim', 'oa'], queryFn: () => api.get('/sap/sim/oa-sources') });
  const [last, setLast] = useState<SimResult | null>(null);
  const act = useAction((id: number) => api.post<SimResult & { oa_no: string }>('/sap/sim/oa', { contract_id: id }), { success: (r) => `SAP simulator created outline agreement ${r.oa_no}`, invalidate: SIM_INVALIDATE, onSuccess: setLast });
  return (
    <div className="stack">
      <SyncResult sync={last?.sync}>{last?.oa_no && <p>Outline agreement <span className="mono">{last.oa_no}</span> carries the platform contract number as its reference, so the platform links it automatically.</p>}</SyncResult>
      <SimPanel title="Create outline agreement for a platform contract">
        <Loader q={q}>{(d) => d.length === 0 ? <Empty title="No contract is Pending SAP">Contracts appear here after approval. The platform never replaces the SAP outline agreement (CON-01).</Empty> : (
          <div className="stack-sm">{d.map((c) => <OaRow key={c.id} c={c} focus={pre === c.id} busy={act.busy} onCreate={() => act.fire(c.id)} />)}</div>
        )}</Loader>
      </SimPanel>
    </div>
  );
}
function OaRow({ c, focus, busy, onCreate }: { c: OaSrc; focus: boolean; busy: boolean; onCreate: () => void }) {
  const ref = useFocusScroll(focus);
  return (
    <div ref={ref} className="row between row-wrap" style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 10, ...focusStyle(focus) }}>
      <div><Ref to={`/contracts/${c.id}`}>{c.contract_no}</Ref> · <Badge tone="deep">{c.type}</Badge> {c.title}
        <div className="small muted">{c.vendor_name}{c.sap_code ? ` (${c.sap_code})` : ' — no SAP code'} · {fmtDate(c.valid_from)} – {fmtDate(c.valid_to)} · cap {fmtMoney(c.value_cap, true)} · {c.items} item(s)</div></div>
      <Button size="sm" variant="deep" icon={<FileSignature />} loading={busy} onClick={onCreate}>Create OA in SAP</Button>
    </div>
  );
}

// ====================================================================== stock
interface StockRow { key: string; material_code: string; plant: string; unrestricted: number; open_po_qty: number; vmi: boolean; changed_at: string; description: { description: string; uom: string } | null }
export function StockTab() {
  const lk = useLookups();
  const q = useQuery<StockRow[]>({ queryKey: ['sim', 'stock'], queryFn: () => api.get('/sap/sim/stock') });
  const [mat, setMat] = useState('');
  const [plant, setPlant] = useState('');
  const [qty, setQty] = useState('');
  const [last, setLast] = useState<SimResult | null>(null);
  const act = useAction(() => api.post<SimResult>('/sap/sim/stock', { material_code: mat, plant, unrestricted: Number(qty) }), { success: `SAP simulator set unrestricted stock of ${mat} at ${plant} to ${qty}`, invalidate: SIM_INVALIDATE, onSuccess: setLast, silentError: true });
  const cols: Column<StockRow>[] = useMemo(() => [
    { key: 'material_code', header: 'Material', render: (r) => <div><span className="mono">{r.material_code}</span><div className="small muted">{r.description?.description}</div></div>, value: (r) => `${r.material_code} ${r.description?.description}` },
    { key: 'plant', header: 'Plant' }, { key: 'unrestricted', header: 'Unrestricted', align: 'right', render: (r) => fmtNum(r.unrestricted) },
    { key: 'open_po_qty', header: 'Open PO qty', align: 'right', render: (r) => fmtNum(r.open_po_qty) }, { key: 'vmi', header: 'VMI', render: (r) => (r.vmi ? <Badge tone="info">VMI</Badge> : '—'), value: (r) => (r.vmi ? 'VMI' : '') },
    { key: 'changed_at', header: 'Changed', render: (r) => fmtDateTime(r.changed_at), hidden: true },
    { key: 'act', header: '', sortable: false, exportable: false, render: (r) => <Button size="sm" variant="ghost" onClick={() => { setMat(r.material_code); setPlant(r.plant); setQty(String(r.unrestricted)); }}>Edit</Button> },
  ], []);
  return (
    <div className="stack">
      <SyncResult sync={last?.sync} />
      <SimPanel title="Set unrestricted stock in SAP">
        <div className="stack">
          <ErrorSummary error={act.error} />
          <div className="form-grid">
            <Field label="Material" required className="span-2"><Select value={mat} onChange={(e) => setMat(e.target.value)} placeholder="Choose a material" options={(lk.data?.materials ?? []).filter((m) => !m.is_service).map((m) => ({ value: m.code, label: `${m.code} — ${m.description}` }))} /></Field>
            <Field label="Plant" required><Select value={plant} onChange={(e) => setPlant(e.target.value)} placeholder="Choose a plant" options={(lk.data?.plants ?? []).map((p) => ({ value: p.code, label: `${p.code} — ${p.name}` }))} /></Field>
            <Field label="Unrestricted stock" required><Input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="deep" icon={<Boxes />} loading={act.busy} disabled={!mat || !plant || qty === ''} onClick={act.fire}>Set stock in SAP simulator</Button></div>
        </div>
      </SimPanel>
      <SimPanel title="Stock in SAP">
        <div style={{ margin: -16 }}><DataTable id="sim-stock" rows={q.data} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.key} columns={cols} dense savedViews={false} filters={[{ key: 'plant', label: 'Plant', value: (r) => r.plant }]}
          mobile={{ title: (r) => <span className="mono">{r.material_code}</span>, meta: (r) => [r.plant, `${fmtNum(r.unrestricted)} unrestricted`] }} /></div>
      </SimPanel>
    </div>
  );
}

// ====================================================================== outage & failure injection
interface Settings { offline: boolean; fail: Record<string, string | null>; outbound_flows: { id: string; name: string; direction: string }[]; modes: string[] }
const MODE_LABEL: Record<string, string> = { transient: 'Transient error (retried with back-off)', business: 'Business error (not retried, SAP/IT alerted)', timeout_after_commit: 'Timeout after SAP committed (retry must not duplicate)' };

export function OutageTab() {
  const q = useQuery<Settings>({ queryKey: ['sim', 'settings'], queryFn: () => api.get('/sap/sim/settings') });
  const [last, setLast] = useState<{ queue: { message: string }; inbound: { docType: string; upserted: number; errors: number }[] } | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const save = useAction((body: Record<string, unknown>) => api.put<{ settings: Settings; recovery: typeof last }>('/sap/sim/settings', body), { success: (r) => (r.recovery ? `SAP is back online — ${r.recovery.queue.message}` : r.settings.offline ? 'SAP simulator is now offline: writes will be queued' : 'SAP simulator settings saved'), invalidate: SIM_INVALIDATE, onSuccess: (r) => setLast(r.recovery) });
  useEffect(() => { setPick({}); }, [q.data]);
  return (
    <div className="stack">
      <Loader q={q}>{(s) => (
        <>
          <SimPanel title="SAP availability">
            <div className="row-wrap between">
              <div><strong>SAP is {s.offline ? 'offline (simulated outage)' : 'online'}</strong><div className="small muted">While offline, inbound syncs fail and every outbound write is saved and queued. The platform stays usable and shows a banner (FR-SAP-12).</div></div>
              <Button variant={s.offline ? 'ok' : 'danger'} icon={<Power />} loading={save.busy} onClick={() => save.fire({ offline: !s.offline })}>{s.offline ? 'Bring SAP back online' : 'Take SAP offline'}</Button>
            </div>
            {last && <div style={{ marginTop: 12 }}><Callout tone="ok" title="SAP is back — queued writes processed">{last.queue.message} Inbound catch-up: {last.inbound.map((i) => `${i.docType} ${i.upserted}${i.errors ? ` (${i.errors} err)` : ''}`).join(' · ')}. <Link to="/integration/errors">Open the error queue</Link></Callout></div>}
          </SimPanel>
          <SimPanel title="Failure injection for the next write">
            <p className="small muted" style={{ marginTop: 0 }}>Arms one failure for the next outbound write of a flow (S2P → SAP). It is cleared after it fires. Outbound writes are controlled by business rules (DEC-03/04/06/25): while a write is switched off, nothing is written to SAP and nothing fails.</p>
            <div className="stack-sm">{s.outbound_flows.map((f) => (
              <div key={f.id} className="row-wrap" style={{ padding: '8px 0', borderBottom: '1px solid var(--steel-100)' }}>
                <div style={{ flex: '1 1 220px' }}><span className="mono">{f.id}</span> {f.name}<div className="small muted">{f.direction}</div></div>
                <div className="row-wrap" style={{ flex: '2 1 340px' }}>
                  <Select aria-label={`Failure mode for ${f.id}`} value={pick[f.id] ?? s.fail[f.id] ?? ''} onChange={(e) => setPick({ ...pick, [f.id]: e.target.value })} placeholder="No failure" options={s.modes.map((m) => ({ value: m, label: MODE_LABEL[m] ?? m }))} />
                  <Button size="sm" variant="deep" icon={<Zap />} loading={save.busy} disabled={(pick[f.id] ?? s.fail[f.id] ?? '') === (s.fail[f.id] ?? '')} onClick={() => save.fire({ fail: { [f.id]: pick[f.id] || null } })}>{pick[f.id] ? 'Arm' : 'Clear'}</Button>
                  {s.fail[f.id] && <Badge tone="warn">Armed: {s.fail[f.id]!.replace(/_/g, ' ')}</Badge>}
                </div>
              </div>
            ))}</div>
          </SimPanel>
        </>
      )}</Loader>
    </div>
  );
}
