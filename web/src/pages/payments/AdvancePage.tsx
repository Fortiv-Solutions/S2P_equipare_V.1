import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CircleDollarSign, Landmark, RefreshCw, Undo2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { Badge, Button, Callout, Card, KV, Loader, PageHeader, Progress, Ref, SimBadge, Status } from '@/components/ui';
import { TrackChain, chainFrom } from '@/components/TrackChain';
import { Field, Input, Textarea, ErrorSummary } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';
import { AuditTrail } from '@/components/AuditTrail';

interface D {
  id: number; adv_no: string; vendor_name: string; vendor_code: string; po_id: number | null; po_no: string | null; contract_id: number | null; contract_no: string | null; po_value: number | null; amount: number; reason: string; status: string; requested_by: number;
  requested_by_name: string; created_at: string; paid_date: string | null; sap_doc: string | null; adjusted_amount: number; outstanding: number; age_days: number | null; bucket: string | null; cancel_reason: string | null;
  approval: { id: number; req_no: string; status: string; outcome: string | null; decided_at: string | null } | null;
  steps: { level: number; approver_role: string; status: string; comment: string | null; acted_at: string | null; acted_by_name: string | null }[];
  invoices: { id: number; inv_ref: string; vendor_invoice_no: string | null; status: string; total_value: number | null; advance_adjusted: number | null }[];
  can_cancel: boolean; can_resubmit: boolean;
}
const CHAIN = ['Requested', 'Approval', 'Approved', 'Paid in SAP', 'Adjusted'];

async function simPost(path: string, body: Record<string, unknown> = {}) {
  try { return await api.post<any>(path, body); } catch (e) {
    if (e instanceof ApiError && e.status === 404 && /unknown api endpoint/i.test(e.message)) throw new Error('The SAP simulator API is not available on this server (404). Ask the integration team to enable it.');
    throw e;
  }
}

/** Advance detail: approval, SAP payment and adjustment status (FR-PAY-02, FR-PAY-06, WF-11). */
export default function AdvancePage() {
  const id = Number(useParams().id);
  const q = useQuery<D>({ queryKey: ['payments', 'advance', id], queryFn: () => api.get(`/payments/advances/${id}`) });
  return <Loader q={q} rows={8}>{(d) => <View d={d} />}</Loader>;
}

function View({ d }: { d: D }) {
  const { can } = useAuth();
  const [dlg, setDlg] = useState<'cancel' | 'adjust' | 'resubmit' | null>(null);
  const inv = [['payments'], ['approvals']];
  const cancel = useAction((reason: string) => api.post(`/payments/advances/${d.id}/cancel`, { reason }), { success: `Advance ${d.adv_no} cancelled`, invalidate: inv });
  const pay = useAction(() => simPost(`/sap/sim/advance/${encodeURIComponent(d.adv_no)}/pay`), { success: 'Paid in the SAP simulator; status synced', invalidate: inv });
  const sim = can('sapsim.fin', 'sapsim.all');
  const cur = ({ Requested: 0, 'Pending approval': 1, Approved: 2, Paid: 3, 'Partially adjusted': 4, 'Fully adjusted': 5, Rejected: 1, Cancelled: 0 } as Record<string, number>)[d.status] ?? 0;
  const against = d.po_no ? `PO ${d.po_no}` : `contract ${d.contract_no}`;
  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/payments?tab=advances">Payments</Link><span>/</span><span className="mono">{d.adv_no}</span></>} screen="SCR-PAY-02"
        title={`Advance ${d.adv_no}`} badges={<Status value={d.status} />}
        sub={<>{d.vendor_name} · {fmtMoney(d.amount)} against {d.po_no ? <Ref to={`/pos/${d.po_id}`}>{against}</Ref> : against} · requested by {d.requested_by_name} on {fmtDate(d.created_at)}</>}
        actions={<>
          {d.can_resubmit && <Button variant="deep" icon={<RefreshCw />} onClick={() => setDlg('resubmit')}>Edit and resubmit</Button>}
          {d.can_cancel && <Button variant="danger" icon={<Undo2 />} onClick={() => setDlg('cancel')}>Cancel advance</Button>}
        </>}
      />
      <Card title="Progress"><TrackChain label="Advance progress" steps={chainFrom(CHAIN, cur, { blockedAt: d.status === 'Rejected' ? 1 : undefined, skipped: d.status === 'Cancelled' ? [1, 2, 3, 4] : undefined })} />
        {d.status === 'Rejected' && <div style={{ marginTop: 12 }}><Callout tone="bad" title="Rejected">{d.approval?.outcome ?? 'The approver rejected this advance.'}</Callout></div>}
        {d.status === 'Requested' && d.approval && <div style={{ marginTop: 12 }}><Callout tone="warn" title="Returned for changes">{d.approval.outcome ?? 'The approver returned the request.'} Edit and resubmit it.</Callout></div>}
        {d.status === 'Cancelled' && <div style={{ marginTop: 12 }}><Callout tone="info" title="Cancelled">{d.cancel_reason}</Callout></div>}
      </Card>
      <div style={{ height: 16 }} />
      <div className="split">
        <div className="stack">
          <Card title="Request"><KV items={[['Amount', fmtMoney(d.amount)], ['Against', against], ['PO value', d.po_value != null ? `${fmtMoney(d.po_value)} (${Math.round((d.amount / d.po_value) * 1000) / 10}% advance)` : '—'], ['Reason', d.reason], ['Requested by', d.requested_by_name]]} /></Card>
          <Card title="Approval" actions={d.approval && <Link to={`/approvals/${d.approval.id}`} className="btn btn--ghost btn--sm">{d.approval.req_no}</Link>}>
            {!d.approval ? <p className="muted small" style={{ margin: 0 }}>No approval request.</p> : (
              <ol className="timeline">{d.steps.map((s, i) => <li key={i}><span className="timeline__dot" data-tone={s.status === 'Approved' ? 'ok' : s.status === 'Rejected' ? 'bad' : 'decision'} aria-hidden /><div className="timeline__title">Level {s.level} · {s.approver_role} <Status value={s.status} /></div><div className="timeline__meta">{s.acted_by_name ? `${s.acted_by_name} · ${fmtDateTime(s.acted_at)}` : 'Waiting'}</div>{s.comment && <div className="timeline__body">{s.comment}</div>}</li>)}</ol>
            )}
          </Card>
          <Card title="Invoices on this PO">
            {d.invoices.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No invoices yet. SAP adjusts the advance when it pays an invoice on this {d.po_no ? 'PO' : 'contract'}.</p> : (
              <ul className="list-plain stack-sm">{d.invoices.map((i) => <li key={i.id} className="row between"><span><Ref to={`/invoices/${i.id}`}>{i.inv_ref}</Ref> <span className="small subtle">{i.vendor_invoice_no}</span></span><span className="small">{fmtMoney(i.total_value, true)} <Status value={i.status} />{i.advance_adjusted ? ` · adjusted ${fmtMoney(i.advance_adjusted, true)}` : ''}</span></li>)}</ul>
            )}
          </Card>
          <Card title="Audit history"><AuditTrail objectType="advance" objectId={d.id} /></Card>
        </div>
        <div className="stack">
          <Card title="SAP payment">
            <div className="stack">
              <KV items={[['Paid in SAP', d.paid_date ? fmtDate(d.paid_date) : 'Not paid yet'], ['SAP document', d.sap_doc], ['Adjusted', `${fmtMoney(d.adjusted_amount)} of ${fmtMoney(d.amount)}`], ['Outstanding', <strong>{d.outstanding ? fmtMoney(d.outstanding) : '—'}</strong>], ['Age since paid', d.age_days != null ? `${d.age_days} days` : '—'], ['Ageing bucket', d.bucket ? <Badge tone="warn">{d.bucket}</Badge> : '—']]} />
              {d.paid_date && <Progress value={d.adjusted_amount} max={d.amount} label="Advance adjusted" />}
              <p className="small muted" style={{ margin: 0 }}>The payment is executed in SAP. Paid date and adjustments appear here only when SAP reports them (INT-M12).</p>
            </div>
          </Card>
          {sim && ['Approved', 'Paid', 'Partially adjusted'].includes(d.status) && (
            <div className="sim-panel stack-sm">
              <div className="row-wrap between"><strong className="small">SAP simulator</strong><SimBadge>Simulator</SimBadge></div>
              <p className="small" style={{ margin: 0 }}>Stands in for SAP. {d.status === 'Approved' ? 'Pay the approved advance.' : 'Record that SAP cleared part of the advance against an invoice.'}</p>
              <div className="row-wrap">
                {d.status === 'Approved' && <Button size="sm" icon={<Landmark />} loading={pay.busy} onClick={pay.fire}>Pay advance in SAP</Button>}
                {['Paid', 'Partially adjusted'].includes(d.status) && <Button size="sm" icon={<CircleDollarSign />} onClick={() => setDlg('adjust')}>Adjust against invoice</Button>}
              </div>
            </div>
          )}
          {d.status === 'Approved' && !sim && can('pay.view') && <Callout tone="info" title="Approved — pay in SAP">Finance executes this payment in SAP. The paid date syncs back here.</Callout>}
        </div>
      </div>
      <ReasonDialog open={dlg === 'cancel'} onClose={() => setDlg(null)} title="Cancel this advance" variant="danger" confirmLabel="Cancel advance" onSubmit={(r) => cancel.run(r)} sub="Only unpaid advances can be cancelled. A paid advance is reversed in SAP." />
      <AdjustDialog d={dlg === 'adjust' ? d : null} onClose={() => setDlg(null)} />
      <ResubmitDialog d={dlg === 'resubmit' ? d : null} onClose={() => setDlg(null)} />
    </>
  );
}

function AdjustDialog({ d, onClose }: { d: D | null; onClose: () => void }) {
  const [amt, setAmt] = useState('');
  const act = useAction(() => simPost(`/sap/sim/advance/${encodeURIComponent(d!.adv_no)}/adjust`, { amount: Number(amt) }), { success: 'Adjustment recorded in the SAP simulator; status synced', invalidate: [['payments']], onSuccess: () => { setAmt(''); onClose(); } });
  return (
    <Modal open={!!d} onClose={onClose} title="Adjust advance (SAP simulator)" sub={d ? `Outstanding ${fmtMoney(d.outstanding)}.` : undefined} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={act.busy} disabled={!(Number(amt) > 0)} onClick={act.fire}>Record adjustment</Button></>}>
      <div className="stack"><ErrorSummary error={act.error} /><Field label="Amount cleared (₹)" required><Input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} data-autofocus /></Field></div>
    </Modal>
  );
}

function ResubmitDialog({ d, onClose }: { d: D | null; onClose: () => void }) {
  const [amt, setAmt] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction(() => api.post(`/payments/advances/${d!.id}/resubmit`, { amount: amt ? Number(amt) : undefined, reason: reason || undefined }), { success: 'Advance resubmitted for approval', invalidate: [['payments'], ['approvals']], onSuccess: onClose });
  return (
    <Modal open={!!d} onClose={onClose} title="Edit and resubmit" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={act.busy} onClick={act.fire}>Resubmit for approval</Button></>}>
      <div className="stack"><ErrorSummary error={act.error} />
        <Field label="Amount (₹)" hint={d ? `Currently ${fmtMoney(d.amount)}. Leave empty to keep it.` : undefined}><Input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} /></Field>
        <Field label="Reason" hint="Leave empty to keep the current reason."><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

