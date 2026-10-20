/** Simulator tabs for purchase orders and goods receipts (sapsim.po, sapsim.grn). */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PackagePlus, Send, PackageCheck, Pencil, Ban, Rocket } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtMoney, fmtNum } from '@/lib/format';
import { Badge, Button, Callout, Card, Empty, Loader, Ref, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/overlay';
import { Checkbox, ErrorSummary, Field, Input, Select } from '@/components/forms';
import { SyncResult } from '../shared';
import { SIM_INVALIDATE, SimPanel, focusStyle, plusDays, today, useFocusScroll, useLookups, type SimResult } from './common';

interface SrcComparison { id: number; cmp_no: string | null; rfq_no: string | null; title: string | null; buyer: string | null; pending: number; vendors: { vendor_id: number; name: string; sap_code: string | null; lines: number; value: number; po_no: string | null }[] }
interface SrcPrLine { id: number; pr_no: string; item: number; description: string; qty: number; uom: string; plant: string; buyer: string | null; reference: { valid: boolean; message: string; contract_no: string; sap_oa_no: string; vendor: string; unit_price: number | null; payment_terms: string; delivery_terms: string } | null; problem?: string }
interface SrcAmd { id: number; amd_no: string | null; po_no: string; po_id: number; type: string | null; changes: { lines: { item: number; new: Record<string, any> }[]; terms?: { new: Record<string, string | null> }; scope?: string }; reason: string | null }
interface Sources { comparisons: SrcComparison[]; pr_lines: SrcPrLine[]; amendments: SrcAmd[] }
interface SapPo { po_no: string; vendor_name: string | null; vendor_sap_code: string; plant: string; po_date: string; released: boolean; cancelled: boolean; version: number; urgency: string; oa_no: string | null; value: number; changed_at: string; platform: { id: number; status: string } | null; items: { item: number; material_code: string; description: string; qty: number; uom: string; unit_price: number; delivery_date: string; received: number; open: number; deleted?: boolean }[] }

export function PoTab({ preComparison, prePrLine }: { preComparison: number | null; prePrLine: number | null }) {
  const src = useQuery<Sources>({ queryKey: ['sim', 'po-sources'], queryFn: () => api.get('/sap/sim/po-sources') });
  const pos = useQuery<SapPo[]>({ queryKey: ['sim', 'pos'], queryFn: () => api.get('/sap/sim/pos') });
  const [release, setRelease] = useState(true);
  const [last, setLast] = useState<SimResult | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'comparison'; c: SrcComparison } | { kind: 'pr'; l: SrcPrLine } | null>(null);
  const [manual, setManual] = useState(false);
  const [change, setChange] = useState<{ po: SapPo; amd?: SrcAmd; cancel?: boolean } | null>(null);

  // Deep links preselect the source and open the confirmation.
  useEffect(() => {
    if (!src.data) return;
    if (preComparison) { const c = src.data.comparisons.find((x) => x.id === preComparison); if (c) setConfirm({ kind: 'comparison', c }); }
    else if (prePrLine) { const l = src.data.pr_lines.find((x) => x.id === prePrLine); if (l) setConfirm({ kind: 'pr', l }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src.data, preComparison, prePrLine]);

  const create = useAction((body: Record<string, unknown>) => api.post<SimResult & { po_nos: string[]; skipped: string[] }>('/sap/sim/po', body), {
    success: (r) => `SAP simulator created PO ${r.po_nos.join(', ')}${r.sync?.synced ? ' and the platform synced it' : ''}`, invalidate: SIM_INVALIDATE, onSuccess: (r) => { setLast(r); setConfirm(null); },
  });
  const rel = useAction((po_no: string) => api.post<SimResult>(`/sap/sim/po/${po_no}/release`), { success: (r) => `SAP simulator released PO ${r.po_no}`, invalidate: SIM_INVALIDATE, onSuccess: setLast });

  const cols: Column<SapPo>[] = useMemo(() => [
    { key: 'po_no', header: 'PO', render: (p) => <span className="mono">{p.po_no}</span> },
    { key: 'vendor_name', header: 'Vendor', render: (p) => p.vendor_name ?? p.vendor_sap_code },
    { key: 'plant', header: 'Plant' },
    { key: 'po_date', header: 'PO date', render: (p) => fmtDate(p.po_date), nowrap: true },
    { key: 'value', header: 'Basic value', align: 'right', render: (p) => fmtMoney(p.value, true) },
    { key: 'state', header: 'SAP status', render: (p) => <Status value={p.cancelled ? 'Cancelled' : p.released ? 'Released' : 'Created, not released'} tone={p.cancelled ? 'bad' : p.released ? 'ok' : 'warn'} />, value: (p) => (p.cancelled ? 'Cancelled' : p.released ? 'Released' : 'Not released') },
    { key: 'version', header: 'Ver.', align: 'right' },
    { key: 'platform', header: 'Platform', render: (p) => (p.platform ? <Ref to={`/pos/${p.platform.id}`}>{p.platform.status}</Ref> : <span className="subtle">Not published</span>), value: (p) => p.platform?.status ?? '' },
    { key: 'act', header: '', sortable: false, exportable: false, render: (p) => p.cancelled || (p.released && !p.items.some((i) => i.open > 0)) ? null : (
      <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
        {!p.released && <Button size="sm" variant="deep" icon={<Rocket />} loading={rel.busy} onClick={() => rel.fire(p.po_no)}>Release</Button>}
        {p.released && <Button size="sm" icon={<Pencil />} onClick={() => setChange({ po: p })}>Change</Button>}
        {p.released && <Button size="sm" variant="danger" icon={<Ban />} onClick={() => setChange({ po: p, cancel: true })}>Cancel PO</Button>}
      </div>) },
  ], [rel]);

  return (
    <div className="stack">
      <SyncResult sync={last?.sync}>{last?.po_nos ? <p>PO {last.po_nos.map((n: string) => <span key={n} className="mono">{n} </span>)}</p> : null}</SyncResult>
      <SimPanel title="Create PO from an approved comparison" actions={<Checkbox label="Release on creation" checked={release} onChange={(e) => setRelease(e.target.checked)} />}>
        <Loader q={src}>{(d) => d.comparisons.length === 0 ? <Empty title="No comparison is released for PO">Approved comparisons in “Released for PO” appear here. One PO is created per awarded vendor.</Empty> : (
          <div className="stack">{d.comparisons.map((c) => <ComparisonCard key={c.id} c={c} focus={preComparison === c.id} onCreate={() => setConfirm({ kind: 'comparison', c })} />)}</div>
        )}</Loader>
      </SimPanel>
      <SimPanel title="Create PO from a contract PR line">
        <Loader q={src}>{(d) => d.pr_lines.length === 0 ? <Empty title="No contract PO is pending">PR lines routed to ARC/OA, FDS, VMI or fixed supplier wait here as “Contract/VMI PO pending”.</Empty> : (
          <div className="stack-sm">{d.pr_lines.map((l) => <PrLineRow key={l.id} l={l} focus={prePrLine === l.id} onCreate={() => setConfirm({ kind: 'pr', l })} />)}</div>
        )}</Loader>
      </SimPanel>
      <SimPanel title="Approved PO amendments to apply in SAP">
        <Loader q={src}>{(d) => d.amendments.length === 0 ? <Empty title="No approved amendment is waiting">Approved amendment and cancellation requests from the PO screen appear here.</Empty> : (
          <div className="stack-sm">{d.amendments.map((a) => {
            const po = pos.data?.find((p) => p.po_no === a.po_no);
            return (
              <div key={a.id} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--steel-100)' }}>
                <div><strong className="mono">{a.amd_no}</strong> · PO <Link to={`/pos/${a.po_id}`} className="mono">{a.po_no}</Link> · <Badge tone="decision">{a.type}</Badge><div className="small muted">{a.reason}</div></div>
                <Button size="sm" variant="deep" disabled={!po} onClick={() => po && setChange({ po, amd: a, cancel: a.type === 'Cancel' && a.changes.scope === 'po' })}>Apply in SAP</Button>
              </div>
            );
          })}</div>
        )}</Loader>
      </SimPanel>
      <SimPanel title="Purchase orders in SAP" actions={<Button size="sm" icon={<PackagePlus />} onClick={() => setManual(true)}>Create manual PO</Button>}>
        <div style={{ margin: -16 }}><DataTable id="sim-pos" rows={pos.data} loading={pos.isLoading} error={pos.error} refetch={pos.refetch} rowKey={(p) => p.po_no} columns={cols} dense savedViews={false} initialSort={{ key: 'po_no', dir: 'desc' }}
          mobile={{ title: (p) => <span className="mono">{p.po_no}</span>, badge: (p) => <Status value={p.cancelled ? 'Cancelled' : p.released ? 'Released' : 'Not released'} />, meta: (p) => [p.vendor_name, p.plant, fmtMoney(p.value, true)] }} /></div>
      </SimPanel>

      <ConfirmCreate state={confirm} release={release} busy={create.busy} onClose={() => setConfirm(null)}
        onConfirm={() => create.fire(confirm?.kind === 'comparison' ? { source: 'comparison', comparison_id: confirm.c.id, release } : { source: 'pr_reference', pr_line_ids: [(confirm as { l: SrcPrLine }).l.id], release })} error={create.error} />
      <ManualPoDialog open={manual} onClose={() => setManual(false)} release={release} onDone={(r) => { setLast(r); setManual(false); }} />
      {change && <ChangeDialog key={`${change.po.po_no}-${change.amd?.id ?? 'x'}-${change.cancel}`} {...change} onClose={() => setChange(null)} onDone={(r) => { setLast(r); setChange(null); }} />}
    </div>
  );
}

function ComparisonCard({ c, focus, onCreate }: { c: SrcComparison; focus: boolean; onCreate: () => void }) {
  const ref = useFocusScroll(focus);
  return (
    <div ref={ref} className="card" style={focusStyle(focus)}>
      <div className="card__body stack-sm">
        <div className="row between row-wrap">
          <div><strong>{c.cmp_no ?? `Comparison ${c.id}`}</strong> · {c.rfq_no} <span className="muted">{c.title}</span><div className="small muted">Buyer {c.buyer ?? '—'}</div></div>
          <Button variant="deep" size="sm" icon={<PackagePlus />} disabled={!c.pending} onClick={onCreate}>{c.pending ? `Create ${c.pending} PO${c.pending === 1 ? '' : 's'} in SAP` : 'POs already created'}</Button>
        </div>
        <div className="tbl-wrap"><table className="tbl tbl--dense"><thead><tr><th>Awarded vendor</th><th className="num">Lines</th><th className="num">Value</th><th>SAP PO</th></tr></thead>
          <tbody>{c.vendors.map((v) => <tr key={v.vendor_id}><td>{v.name}{!v.sap_code && <span className="small" style={{ color: 'var(--bad)' }}> · no SAP code</span>}</td><td className="num">{v.lines}</td><td className="num">{fmtMoney(v.value, true)}</td><td>{v.po_no ? <span className="mono">{v.po_no}</span> : <span className="muted">To be created</span>}</td></tr>)}</tbody></table></div>
      </div>
    </div>
  );
}

function PrLineRow({ l, focus, onCreate }: { l: SrcPrLine; focus: boolean; onCreate: () => void }) {
  const ref = useFocusScroll(focus);
  return (
    <div ref={ref} className="row between row-wrap" style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 10, ...focusStyle(focus) }}>
      <div><Ref to={`/pr/${l.id}`}>{l.pr_no}/{l.item}</Ref> · {l.description} · {l.qty} {l.uom} · {l.plant}
        <div className="small muted">{l.reference ? <>OA <span className="mono">{l.reference.sap_oa_no}</span> ({l.reference.contract_no}) · {l.reference.vendor} · {fmtMoney(l.reference.unit_price)} · {l.reference.payment_terms}</> : l.problem}</div>
        {l.reference && !l.reference.valid && <div className="small" style={{ color: 'var(--bad)' }}>{l.reference.message}</div>}
      </div>
      <Button size="sm" variant="deep" icon={<PackagePlus />} disabled={!l.reference?.valid} onClick={onCreate}>Create PO in SAP</Button>
    </div>
  );
}

function ConfirmCreate({ state, release, busy, onClose, onConfirm, error }: { state: { kind: 'comparison'; c: SrcComparison } | { kind: 'pr'; l: SrcPrLine } | null; release: boolean; busy: boolean; onClose: () => void; onConfirm: () => void; error: unknown }) {
  return (
    <Modal open={!!state} onClose={onClose} title={state?.kind === 'comparison' ? `Create POs for ${state.c.cmp_no ?? 'comparison'}` : 'Create contract PO'} sub="Performed in the SAP simulator, then synced into the platform."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={busy} icon={<Send />} onClick={onConfirm}>Create in SAP simulator</Button></>}>
      <div className="stack">
        <ErrorSummary error={error} />
        {state?.kind === 'comparison' && <p>One PO per awarded vendor will be created ({state.c.vendors.filter((v) => !v.po_no).map((v) => v.name).join(', ')}) carrying the RFQ, comparison, RFQ date, PR references and the vendor’s quoted payment and delivery terms. Buyer: {state.c.buyer ?? '—'}.</p>}
        {state?.kind === 'pr' && state.l.reference && <p>PO against outline agreement <span className="mono">{state.l.reference.sap_oa_no}</span> for {state.l.qty} {state.l.uom} of {state.l.description} with {state.l.reference.vendor} at {fmtMoney(state.l.reference.unit_price)}.</p>}
        <Callout tone="info">{release ? 'The PO will be released in SAP, so it is published to the vendor on sync.' : 'The PO will be created but not released; it stays hidden from the vendor until released.'} Change this with “Release on creation”.</Callout>
      </div>
    </Modal>
  );
}

interface ManualItem { material_code: string; qty: string; unit_price: string; delivery_date: string; pr_no: string; pr_item: string }
function ManualPoDialog({ open, onClose, release, onDone }: { open: boolean; onClose: () => void; release: boolean; onDone: (r: SimResult) => void }) {
  const { me } = useAuth();
  const lk = useLookups();
  const [vendor, setVendor] = useState('');
  const [plant, setPlant] = useState('');
  const [buyer, setBuyer] = useState('');
  const [payment, setPayment] = useState('45 days from GRN');
  const [delivery, setDelivery] = useState('FOR destination');
  const [items, setItems] = useState<ManualItem[]>([{ material_code: '', qty: '', unit_price: '', delivery_date: plusDays(14), pr_no: '', pr_item: '' }]);
  useEffect(() => { if (open && lk.data) { setBuyer((b) => b || String(lk.data!.buyers.find((x) => x.email === me?.email)?.id ?? '')); } }, [open, lk.data, me]);
  const act = useAction(() => api.post<SimResult & { po_nos: string[] }>('/sap/sim/po', {
    source: 'manual', vendor_id: Number(vendor), plant, buyer_id: Number(buyer), payment_terms: payment, delivery_terms: delivery, release,
    items: items.map((i) => ({ material_code: i.material_code, qty: Number(i.qty), unit_price: Number(i.unit_price), delivery_date: i.delivery_date, ...(i.pr_no ? { pr_no: i.pr_no, pr_item: Number(i.pr_item) || 10 } : {}) })),
  }), { success: (r) => `SAP simulator created PO ${r.po_nos[0]}`, invalidate: SIM_INVALIDATE, onSuccess: onDone, silentError: true });
  const set = (i: number, k: keyof ManualItem, v: string) => setItems(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const mats = lk.data?.materials ?? [];
  return (
    <Modal open={open} onClose={onClose} wide title="Create manual PO in SAP simulator" sub="For purchases outside an RFQ or contract. Prices and quantities are entered as in SAP."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={!vendor || !plant || !buyer || items.some((i) => !i.material_code || !(Number(i.qty) > 0) || i.unit_price === '')} onClick={act.fire}>Create PO</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <div className="form-grid">
          <Field label="Vendor" required><Select value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Choose a vendor" options={(lk.data?.vendors ?? []).filter((v) => !v.sap_blocked).map((v) => ({ value: v.id, label: `${v.name} (${v.sap_code})` }))} /></Field>
          <Field label="Plant" required><Select value={plant} onChange={(e) => setPlant(e.target.value)} placeholder="Choose a plant" options={(lk.data?.plants ?? []).map((p) => ({ value: p.code, label: `${p.code} — ${p.name}` }))} /></Field>
          <Field label="Buyer" required><Select value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="Choose a buyer" options={(lk.data?.buyers ?? []).map((b) => ({ value: b.id, label: b.name }))} /></Field>
          <Field label="Delivery terms"><Select value={delivery} onChange={(e) => setDelivery(e.target.value)} options={['FOR destination', 'Ex-Works']} /></Field>
          <Field label="Payment terms" className="span-2"><Input value={payment} onChange={(e) => setPayment(e.target.value)} maxLength={120} /></Field>
        </div>
        <h3 className="section-title">Items</h3>
        {items.map((it, i) => (
          <div key={i} className="form-grid" style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 10 }}>
            <Field label={`Item ${(i + 1) * 10} material`} required className="span-2"><Select value={it.material_code} onChange={(e) => set(i, 'material_code', e.target.value)} placeholder="Choose a material" options={mats.map((m) => ({ value: m.code, label: `${m.code} — ${m.description}` }))} /></Field>
            <Field label="Quantity" required><Input type="number" min={0} step="any" value={it.qty} onChange={(e) => set(i, 'qty', e.target.value)} /></Field>
            <Field label="Unit price (₹)" required><Input type="number" min={0} step="any" value={it.unit_price} onChange={(e) => set(i, 'unit_price', e.target.value)} /></Field>
            <Field label="Delivery date" required><Input type="date" value={it.delivery_date} onChange={(e) => set(i, 'delivery_date', e.target.value)} /></Field>
            <Field label="PR reference (optional)" hint="PR number and item, e.g. 10045501 / 10"><div className="row"><Input value={it.pr_no} onChange={(e) => set(i, 'pr_no', e.target.value)} placeholder="PR no." /><Input value={it.pr_item} onChange={(e) => set(i, 'pr_item', e.target.value)} placeholder="Item" style={{ maxWidth: 80 }} /></div></Field>
            {items.length > 1 && <div className="span-2"><Button size="sm" variant="ghost" onClick={() => setItems(items.filter((_, j) => j !== i))}>Remove item</Button></div>}
          </div>
        ))}
        <div><Button size="sm" onClick={() => setItems([...items, { material_code: '', qty: '', unit_price: '', delivery_date: plusDays(14), pr_no: '', pr_item: '' }])}>Add item</Button></div>
      </div>
    </Modal>
  );
}

function ChangeDialog({ po, amd, cancel, onClose, onDone }: { po: SapPo; amd?: SrcAmd; cancel?: boolean; onClose: () => void; onDone: (r: SimResult) => void }) {
  const init = Object.fromEntries(po.items.filter((i) => !i.deleted).map((i) => {
    const ch = amd?.changes.lines.find((l) => l.item === i.item)?.new ?? {};
    return [i.item, { qty: String(ch.qty ?? i.qty), unit_price: String(ch.unit_price ?? i.unit_price), delivery_date: String(ch.delivery_date ?? i.delivery_date), deleted: !!ch.deleted }];
  }));
  const [vals, setVals] = useState<Record<number, { qty: string; unit_price: string; delivery_date: string; deleted: boolean }>>(init);
  const body = () => {
    const changes = po.items.filter((i) => !i.deleted).flatMap((i) => {
      const v = vals[i.item];
      if (v.deleted) return [{ item: i.item, deleted: true }];
      const c: Record<string, unknown> = { item: i.item };
      if (Number(v.qty) !== i.qty) c.qty = Number(v.qty);
      if (Number(v.unit_price) !== i.unit_price) c.unit_price = Number(v.unit_price);
      if (v.delivery_date !== i.delivery_date) c.delivery_date = v.delivery_date;
      return Object.keys(c).length > 1 ? [c] : [];
    });
    return { changes: cancel ? [] : changes, cancel: cancel || undefined, amendment_id: amd?.id, terms: amd?.changes.terms?.new };
  };
  const act = useAction(() => api.post<SimResult & { version: number }>(`/sap/sim/po/${po.po_no}/change`, body()), {
    success: (r) => `SAP simulator ${cancel ? 'cancelled' : 'changed'} PO ${po.po_no} (version ${r.version})`, invalidate: SIM_INVALIDATE, onSuccess: onDone, silentError: true,
  });
  const set = (item: number, k: string, v: string | boolean) => setVals({ ...vals, [item]: { ...vals[item], [k]: v } });
  return (
    <Modal open onClose={onClose} wide title={`${cancel ? 'Cancel' : 'Change'} PO ${po.po_no}${amd ? ` — ${amd.amd_no}` : ''}`} sub="Creates a new SAP version of the PO; the platform republishes it to the vendor."
      footer={<><Button onClick={onClose}>Close</Button><Button variant={cancel ? 'danger' : 'deep'} loading={act.busy} onClick={act.fire}>{cancel ? 'Cancel PO in SAP' : 'Change PO in SAP'}</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        {cancel ? <Callout tone="warn" title="The whole PO will be cancelled in SAP">{amd ? `Approved request ${amd.amd_no}: ${amd.reason}` : 'Cancellation is refused when goods have already been received.'}</Callout> : (
          <>
            {amd?.changes.terms && <Callout tone="info" title="Terms change in this amendment">{Object.entries(amd.changes.terms.new).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')}</Callout>}
            <div className="tbl-wrap"><table className="tbl tbl--dense"><thead><tr><th>Item</th><th className="num">Received</th><th>Quantity</th><th>Unit price</th><th>Delivery</th><th>Delete</th></tr></thead>
              <tbody>{po.items.filter((i) => !i.deleted).map((i) => (
                <tr key={i.item}><td><div className="mono">{i.item}</div><div className="small muted">{i.description}</div></td><td className="num">{fmtNum(i.received)}</td>
                  <td><Input type="number" step="any" value={vals[i.item].qty} onChange={(e) => set(i.item, 'qty', e.target.value)} style={{ minWidth: 80 }} /></td>
                  <td><Input type="number" step="any" value={vals[i.item].unit_price} onChange={(e) => set(i.item, 'unit_price', e.target.value)} style={{ minWidth: 100 }} /></td>
                  <td><Input type="date" value={vals[i.item].delivery_date} onChange={(e) => set(i.item, 'delivery_date', e.target.value)} /></td>
                  <td><input type="checkbox" aria-label={`Delete item ${i.item}`} checked={vals[i.item].deleted} onChange={(e) => set(i.item, 'deleted', e.target.checked)} /></td></tr>
              ))}</tbody></table></div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ====================================================================== GRN / SES
interface GrnPo extends SapPo { asns: { id: number; asn_no: string; status: string; expected_date: string | null }[] }

export function GrnTab({ prePo }: { prePo: string | null }) {
  const q = useQuery<GrnPo[]>({ queryKey: ['sim', 'grn-sources'], queryFn: () => api.get('/sap/sim/grn-sources') });
  const [po, setPo] = useState(prePo ?? '');
  const [qty, setQty] = useState<Record<number, string>>({});
  const [asn, setAsn] = useState('');
  const [date, setDate] = useState(today());
  const [last, setLast] = useState<SimResult | null>(null);
  const sel = q.data?.find((p) => p.po_no === po);
  useEffect(() => { setQty({}); setAsn(''); }, [po]);
  const act = useAction(() => api.post<SimResult & { grn_no: string }>('/sap/sim/grn', {
    po_no: po, asn_id: asn ? Number(asn) : null, posting_date: date,
    items: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([k, v]) => ({ po_item: Number(k), qty: Number(v) })),
  }), { success: (r) => `SAP simulator posted GRN ${r.grn_no}${r.sync?.synced ? ' and the platform synced it' : ''}`, invalidate: SIM_INVALIDATE, onSuccess: (r) => { setLast(r); setQty({}); }, silentError: true });
  const total = Object.values(qty).reduce((s, v) => s + (Number(v) || 0), 0);
  return (
    <div className="stack">
      <SyncResult sync={last?.sync}>{last?.grn_no && <p>Goods receipt <span className="mono">{last.grn_no}</span> posted.</p>}</SyncResult>
      <SimPanel title="Post goods receipt / service entry">
        <Loader q={q}>{(d) => d.length === 0 ? <Empty title="No PO has open quantity">Released POs with quantity still to receive appear here.</Empty> : (
          <div className="stack">
            <ErrorSummary error={act.error} />
            <div className="form-grid">
              <Field label="Purchase order" required><Select value={po} onChange={(e) => setPo(e.target.value)} placeholder="Choose an open PO" options={d.map((p) => ({ value: p.po_no, label: `${p.po_no} — ${p.vendor_name} (${p.plant})` }))} /></Field>
              <Field label="Posting date" required><Input type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            </div>
            {sel && (
              <>
                <div className="tbl-wrap"><table className="tbl tbl--dense"><thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Open</th><th>Receive now</th></tr></thead>
                  <tbody>{sel.items.filter((i) => i.open > 0).map((i) => (
                    <tr key={i.item}><td><span className="mono">{i.item}</span> {i.description}</td><td className="num">{fmtNum(i.qty)} {i.uom}</td><td className="num">{fmtNum(i.received)}</td><td className="num">{fmtNum(i.open)}</td>
                      <td><div className="row"><Input type="number" min={0} max={i.open} step="any" value={qty[i.item] ?? ''} onChange={(e) => setQty({ ...qty, [i.item]: e.target.value })} aria-label={`Quantity for item ${i.item}`} style={{ maxWidth: 110 }} /><Button size="sm" variant="ghost" onClick={() => setQty({ ...qty, [i.item]: String(i.open) })}>All open</Button></div></td></tr>
                  ))}</tbody></table></div>
                {sel.asns.length > 0 && <Field label="Against ASN (optional)" hint="Marks the ASN Delivered when posted."><Select value={asn} onChange={(e) => setAsn(e.target.value)} placeholder="No ASN" options={sel.asns.map((a) => ({ value: a.id, label: `${a.asn_no} — ${a.status}${a.expected_date ? `, expected ${fmtDate(a.expected_date)}` : ''}` }))} /></Field>}
                <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="deep" icon={<PackageCheck />} loading={act.busy} disabled={!(total > 0)} onClick={act.fire}>Post receipt in SAP simulator</Button></div>
              </>
            )}
          </div>
        )}</Loader>
      </SimPanel>
    </div>
  );
}
