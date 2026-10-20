/** Simulator tabs for invoices and advances (sapsim.fin). Finance control applies in the simulator too. */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileCheck2, Banknote, ShieldBan, Unlock, Stamp, Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Badge, Button, Callout, Ref, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal, ReasonDialog } from '@/components/overlay';
import { ErrorSummary, Field, Input, Textarea } from '@/components/forms';
import { SyncResult } from '../shared';
import { SIM_INVALIDATE, SimPanel, focusStyle, useFocusScroll, type SimResult } from './common';

interface Inv { id: number; inv_ref: string; vendor_name: string; po_no: string | null; status: string; total_value: number | null; approved_by_name: string | null; open_exceptions: number; finance_block: string | null; due_date: string | null; advance_adjusted: number | null }

export function InvoiceTab({ pre }: { pre: string | null }) {
  const q = useQuery<Inv[]>({ queryKey: ['sim', 'invoices'], queryFn: () => api.get('/sap/sim/invoices') });
  const [last, setLast] = useState<SimResult | null>(null);
  const [dlg, setDlg] = useState<{ kind: 'pay' | 'block' | 'unblock'; inv: Inv } | null>(null);
  const simple = useAction((v: { inv: Inv; action: 'park' | 'post' }) => api.post<SimResult>(`/sap/sim/invoice/${v.inv.inv_ref}/${v.action}`), {
    success: (r) => `SAP simulator ${r.sap_doc_no ? `${r.due_date ? 'posted' : 'parked'} ${r.inv_ref} as document ${r.sap_doc_no}` : 'updated the invoice'}${r.due_date ? `, due ${fmtDate(r.due_date)}` : ''}`, invalidate: SIM_INVALIDATE, onSuccess: setLast,
  });
  const actions = (i: Inv, full = false) => {
    const canPP = ['Matched', 'Exception', 'Parked'].includes(i.status);
    return (
      <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
        <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
          {canPP && i.status !== 'Parked' && <Button size="sm" icon={<FileCheck2 />} disabled={!!i.finance_block} onClick={() => simple.fire({ inv: i, action: 'park' })}>Park</Button>}
          {canPP && <Button size="sm" variant="deep" icon={<Stamp />} disabled={!!i.finance_block} onClick={() => simple.fire({ inv: i, action: 'post' })}>Post</Button>}
          {['Posted', 'Payment due'].includes(i.status) && <><Button size="sm" variant="deep" icon={<Banknote />} onClick={() => setDlg({ kind: 'pay', inv: i })}>Pay</Button><Button size="sm" variant="danger" icon={<ShieldBan />} onClick={() => setDlg({ kind: 'block', inv: i })}>Block payment</Button></>}
          {i.status === 'Payment blocked' && <Button size="sm" icon={<Unlock />} onClick={() => setDlg({ kind: 'unblock', inv: i })}>Remove block</Button>}
        </div>
        {canPP && i.finance_block && <span className="small" title={i.finance_block} style={{ color: 'var(--bad)', maxWidth: 360, textAlign: 'right' }}>{full ? `Finance control: ${i.finance_block}` : 'Needs finance approval first (hover for detail)'}</span>}
      </div>
    );
  };
  const cols: Column<Inv>[] = useMemo(() => [
    { key: 'inv_ref', header: 'Invoice', render: (i) => <Ref to={`/invoices/${i.id}`}>{i.inv_ref}</Ref> },
    { key: 'vendor_name', header: 'Vendor' }, { key: 'po_no', header: 'PO', render: (i) => <span className="mono">{i.po_no ?? '—'}</span> },
    { key: 'total_value', header: 'Total', align: 'right', render: (i) => fmtMoney(i.total_value) },
    { key: 'status', header: 'Status', render: (i) => <Status value={i.status} /> },
    { key: 'approved_by_name', header: 'Finance approval', render: (i) => (i.approved_by_name ? <Badge tone="ok">{i.approved_by_name}</Badge> : <Badge tone="warn">Not approved</Badge>), value: (i) => i.approved_by_name ?? 'Not approved' },
    { key: 'due_date', header: 'Due', render: (i) => fmtDate(i.due_date), nowrap: true },
    { key: 'act', header: '', sortable: false, exportable: false, render: (i) => actions(i) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [simple.busy]);
  const selected = q.data?.find((i) => i.inv_ref === pre);
  return (
    <div className="stack">
      <SyncResult sync={last?.sync} />
      <Callout tone="info" title="Finance control applies here">The simulator refuses to park or post an invoice that finance has not approved (matched, or exceptions approved) — the same rule as in the platform (FR-INV-19).</Callout>
      {pre && <SelectedInvoice inv={selected} invRef={pre} actions={actions} />}
      <SimPanel title="Invoices in SAP">
        <div style={{ margin: -16 }}><DataTable id="sim-invoices" rows={q.data} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(i) => i.inv_ref} columns={cols} dense savedViews={false}
          filters={[{ key: 'status', label: 'Status', value: (i) => i.status }]}
          empty={<div className="empty"><div className="empty__title">No invoices yet</div><div>Vendors upload invoices in the portal; finance approves them for parking or posting.</div></div>}
          mobile={{ title: (i) => <span className="mono">{i.inv_ref}</span>, badge: (i) => <Status value={i.status} />, meta: (i) => [i.vendor_name, fmtMoney(i.total_value), i.approved_by_name ? 'Finance approved' : 'Not approved'] }} /></div>
      </SimPanel>
      {dlg?.kind === 'pay' && <PayDialog inv={dlg.inv} onClose={() => setDlg(null)} onDone={(r) => { setLast(r); setDlg(null); }} />}
      {dlg?.kind === 'block' && <BlockDialog inv={dlg.inv} onClose={() => setDlg(null)} onDone={(r) => { setLast(r); setDlg(null); }} />}
      <UnblockDialog inv={dlg?.kind === 'unblock' ? dlg.inv : null} onClose={() => setDlg(null)} onDone={setLast} />
    </div>
  );
}

function SelectedInvoice({ inv, invRef, actions }: { inv?: Inv; invRef: string; actions: (i: Inv, full?: boolean) => React.ReactNode }) {
  const ref = useFocusScroll(!!inv);
  return (
    <div ref={ref} className="card" style={focusStyle(true)}>
      <div className="card__body row between row-wrap">
        {inv ? <div><strong>Invoice {inv.inv_ref}</strong> · {inv.vendor_name} · {fmtMoney(inv.total_value)} <Status value={inv.status} /><div className="small muted">Selected from the invoice screen. Finance approval: {inv.approved_by_name ?? 'none yet'}.</div></div> : <span>Invoice {invRef} was not found.</span>}
        {inv && actions(inv, true)}
      </div>
    </div>
  );
}

function PayDialog({ inv, onClose, onDone }: { inv: Inv; onClose: () => void; onDone: (r: SimResult) => void }) {
  const [ref, setRef] = useState('');
  const [tds, setTds] = useState('');
  const [retention, setRetention] = useState('');
  const [adv, setAdv] = useState(inv.advance_adjusted ? String(inv.advance_adjusted) : '');
  const [ded, setDed] = useState<{ label: string; amount: string }[]>([]);
  const net = (inv.total_value ?? 0) - (Number(tds) || 0) - (Number(retention) || 0) - (Number(adv) || 0) - ded.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const act = useAction(() => api.post<SimResult & { payment_ref: string; net_paid: number }>(`/sap/sim/invoice/${inv.inv_ref}/pay`, {
    payment_ref: ref.trim() || undefined, ...(tds !== '' ? { tds: Number(tds) } : {}), ...(retention !== '' ? { retention: Number(retention) } : {}), ...(adv !== '' ? { advance_adjusted: Number(adv) } : {}),
    deductions: ded.filter((d) => d.label && Number(d.amount) > 0).map((d) => ({ label: d.label, amount: Number(d.amount) })),
  }), { success: (r) => `SAP simulator paid ${inv.inv_ref}: ${fmtMoney(r.net_paid)} (ref ${r.payment_ref})`, invalidate: SIM_INVALIDATE, onSuccess: onDone, silentError: true });
  return (
    <Modal open onClose={onClose} title={`Pay invoice ${inv.inv_ref}`} sub="Posts the payment in the SAP simulator; the platform and vendor see the status and payment advice after sync."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={net < 0} onClick={act.fire}>Pay in SAP simulator</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <p className="small muted">Invoice total {fmtMoney(inv.total_value)}. Leave TDS, retention or deductions empty if SAP would not provide them — they are then hidden from the vendor, not shown as zero.</p>
        <div className="form-grid">
          <Field label="Payment reference" hint="Left blank, SAP generates one."><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={40} /></Field>
          <Field label="TDS (₹)"><Input type="number" min={0} step="any" value={tds} onChange={(e) => setTds(e.target.value)} /></Field>
          <Field label="Retention (₹)"><Input type="number" min={0} step="any" value={retention} onChange={(e) => setRetention(e.target.value)} /></Field>
          <Field label="Advance adjusted (₹)"><Input type="number" min={0} step="any" value={adv} onChange={(e) => setAdv(e.target.value)} /></Field>
        </div>
        {ded.map((d, i) => (
          <div key={i} className="row"><Input aria-label="Deduction name" placeholder="Deduction (e.g. debit note DN-12)" value={d.label} onChange={(e) => setDed(ded.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /><Input aria-label="Deduction amount" type="number" min={0} step="any" placeholder="₹" value={d.amount} onChange={(e) => setDed(ded.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} style={{ maxWidth: 130 }} /><Button size="sm" variant="ghost" iconOnly icon={<X />} onClick={() => setDed(ded.filter((_, j) => j !== i))}>Remove deduction</Button></div>
        ))}
        <div><Button size="sm" icon={<Plus />} onClick={() => setDed([...ded, { label: '', amount: '' }])}>Add deduction</Button></div>
        <Callout tone={net < 0 ? 'bad' : 'info'} title={`Net paid ${fmtMoney(net)}`}>{net < 0 ? 'Deductions exceed the invoice total.' : 'Invoice total less TDS, retention, advance adjustment and deductions.'}</Callout>
      </div>
    </Modal>
  );
}

function BlockDialog({ inv, onClose, onDone }: { inv: Inv; onClose: () => void; onDone: (r: SimResult) => void }) {
  const [internal, setInternal] = useState('');
  const [vendor, setVendor] = useState('');
  const act = useAction(() => api.post<SimResult>(`/sap/sim/invoice/${inv.inv_ref}/block`, { reason_internal: internal.trim(), vendor_reason: vendor.trim() }), { success: `SAP simulator blocked payment of ${inv.inv_ref}`, invalidate: SIM_INVALIDATE, onSuccess: onDone, silentError: true });
  return (
    <Modal open onClose={onClose} title={`Block payment of ${inv.inv_ref}`} sub="Two reasons are kept: the internal reason, and the wording the vendor may see (DEC-19)."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" loading={act.busy} disabled={internal.trim().length < 10 || vendor.trim().length < 5} onClick={act.fire}>Block payment</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        <Field label="Internal reason" required hint="At least 10 characters. Never shown to the vendor."><Textarea rows={3} value={internal} onChange={(e) => setInternal(e.target.value)} maxLength={500} /></Field>
        <Field label="Vendor-safe reason" required hint="Shown to the vendor. No internal remarks, prices of other vendors or disputes between teams."><Textarea rows={2} value={vendor} onChange={(e) => setVendor(e.target.value)} maxLength={300} /></Field>
      </div>
    </Modal>
  );
}

function UnblockDialog({ inv, onClose, onDone }: { inv: Inv | null; onClose: () => void; onDone: (r: SimResult) => void }) {
  const act = useAction((reason: string) => api.post<SimResult>(`/sap/sim/invoice/${inv!.inv_ref}/unblock`, { reason }), { success: 'SAP simulator removed the payment block', invalidate: SIM_INVALIDATE, onSuccess: onDone });
  return <ReasonDialog open={!!inv} onClose={onClose} title={`Remove payment block on ${inv?.inv_ref ?? ''}`} confirmLabel="Remove block" variant="deep" onSubmit={(r) => act.run(r)} />;
}

// ====================================================================== advances
interface Adv { id: number; adv_no: string; amount: number; status: string; vendor_name: string | null; po_no: string | null; adjusted_amount: number; paid_date: string | null; sap_doc: string | null }

export function AdvanceTab({ pre }: { pre: string | null }) {
  const q = useQuery<Adv[]>({ queryKey: ['sim', 'advances'], queryFn: () => api.get('/sap/sim/advances') });
  const [last, setLast] = useState<SimResult | null>(null);
  const [dlg, setDlg] = useState<{ kind: 'pay' | 'adjust'; adv: Adv } | null>(null);
  const actions = (a: Adv) => (
    <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
      {a.status === 'Approved' && <Button size="sm" variant="deep" icon={<Banknote />} onClick={() => setDlg({ kind: 'pay', adv: a })}>Pay in SAP</Button>}
      {['Paid', 'Partially adjusted'].includes(a.status) && <Button size="sm" icon={<Stamp />} onClick={() => setDlg({ kind: 'adjust', adv: a })}>Adjust against invoice</Button>}
    </div>
  );
  const cols: Column<Adv>[] = useMemo(() => [
    { key: 'adv_no', header: 'Advance', render: (a) => <Ref to={`/advances/${a.id}`}>{a.adv_no}</Ref> },
    { key: 'vendor_name', header: 'Vendor' }, { key: 'po_no', header: 'PO', render: (a) => <span className="mono">{a.po_no ?? '—'}</span> },
    { key: 'amount', header: 'Amount', align: 'right', render: (a) => fmtMoney(a.amount, true) },
    { key: 'adjusted_amount', header: 'Adjusted', align: 'right', render: (a) => fmtMoney(a.adjusted_amount, true) },
    { key: 'status', header: 'Status', render: (a) => <Status value={a.status} /> },
    { key: 'paid_date', header: 'Paid', render: (a) => fmtDate(a.paid_date), nowrap: true },
    { key: 'act', header: '', sortable: false, exportable: false, render: actions },
  ], []);
  const selected = q.data?.find((a) => a.adv_no === pre);
  const ref = useFocusScroll(!!selected);
  return (
    <div className="stack">
      <SyncResult sync={last?.sync} />
      {selected && <div ref={ref} className="card" style={focusStyle(true)}><div className="card__body row between row-wrap"><div><strong>Advance {selected.adv_no}</strong> · {selected.vendor_name} · {fmtMoney(selected.amount, true)} <Status value={selected.status} /></div>{actions(selected)}</div></div>}
      {pre && !selected && q.data && <Callout tone="warn" title={`Advance ${pre} is not payable yet`}>Only approved or paid advances appear here. Approve the request first in Approvals.</Callout>}
      <SimPanel title="Advances in SAP">
        <div style={{ margin: -16 }}><DataTable id="sim-advances" rows={q.data} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(a) => a.adv_no} columns={cols} dense savedViews={false}
          empty={<div className="empty"><div className="empty__title">No approved advance</div><div>Advances appear here once approved through Module 5.</div></div>}
          mobile={{ title: (a) => <span className="mono">{a.adv_no}</span>, badge: (a) => <Status value={a.status} />, meta: (a) => [a.vendor_name, fmtMoney(a.amount, true)] }} /></div>
      </SimPanel>
      {dlg && <AdvDialog key={`${dlg.kind}-${dlg.adv.adv_no}`} {...dlg} onClose={() => setDlg(null)} onDone={(r) => { setLast(r); setDlg(null); }} />}
    </div>
  );
}

function AdvDialog({ kind, adv, onClose, onDone }: { kind: 'pay' | 'adjust'; adv: Adv; onClose: () => void; onDone: (r: SimResult) => void }) {
  const left = adv.amount - adv.adjusted_amount;
  const [amount, setAmount] = useState(String(kind === 'pay' ? adv.amount : left));
  const act = useAction(() => api.post<SimResult>(`/sap/sim/advance/${adv.adv_no}/${kind}`, { amount: Number(amount) }), {
    success: kind === 'pay' ? `SAP simulator paid advance ${adv.adv_no}` : `SAP simulator adjusted ${fmtMoney(Number(amount))} of ${adv.adv_no}`, invalidate: SIM_INVALIDATE, onSuccess: onDone, silentError: true,
  });
  return (
    <Modal open onClose={onClose} title={kind === 'pay' ? `Pay advance ${adv.adv_no}` : `Adjust advance ${adv.adv_no}`} sub={kind === 'pay' ? `Approved amount ${fmtMoney(adv.amount)}.` : `${fmtMoney(left)} is still unadjusted.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={!(Number(amount) > 0)} onClick={act.fire}>{kind === 'pay' ? 'Pay in SAP simulator' : 'Adjust in SAP simulator'}</Button></>}>
      <div className="stack"><ErrorSummary error={act.error} /><Field label="Amount (₹)" required><Input type="number" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} data-autofocus /></Field></div>
    </Modal>
  );
}
