/** Pieces shared by the contract screens: utilisation bar and renewal actions (WF-12). */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCcw, CalendarPlus, Hourglass, Ban } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtPct } from '@/lib/format';
import { Button, Progress, SimBadge } from '@/components/ui';
import { Field, Input, Textarea, ErrorSummary } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';

export function UtilBar({ pct, warnPct = 80, label }: { pct: number | null | undefined; warnPct?: number; label?: string }) {
  if (pct == null) return <span className="subtle small">No cap</span>;
  const tone = pct >= 1 ? 'bad' : pct * 100 >= warnPct ? 'warn' : undefined;
  return (
    <div style={{ minWidth: 110 }}>
      <div className="row between small" style={{ marginBottom: 3 }}>
        <span className="num" style={{ fontWeight: 600, color: tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : undefined }}>{fmtPct(pct, 0)}</span>
        {tone && <span className="small" style={{ color: tone === 'bad' ? 'var(--bad)' : 'var(--warn)', fontWeight: 600 }}>{tone === 'bad' ? 'Cap reached' : `≥ ${warnPct}%`}</span>}
      </div>
      <Progress value={Math.min(pct, 1) * 100} tone={tone} label={label ?? 'Utilisation'} />
    </div>
  );
}

const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

/** Renew / extend in SAP / let expire / terminate — the owner's choices for a contract in or near its lead time. */
export function RenewalActions({ c, size = 'sm', invalidate }: { c: { id: number; contract_no: string; status: string; valid_to: string; sap_oa_no: string | null }; size?: 'sm' | 'md'; invalidate?: unknown[][] }) {
  const navigate = useNavigate();
  const [dlg, setDlg] = useState<'renew' | 'extend' | 'expire' | 'terminate' | null>(null);
  const inv = (invalidate ?? [['contracts']]) as any;
  const renew = useAction((b: { valid_from: string; valid_to: string; reason: string }) => api.post(`/contracts/${c.id}/renew`, b), {
    success: (r: any) => `Renewal draft ${r.contract_no} created`, invalidate: inv, onSuccess: (r: any) => navigate(`/contracts/${r.id}`), silentError: true,
  });
  const extend = useAction((b: { valid_to: string; reason: string }) => api.post(`/contracts/${c.id}/extend`, b), { success: 'Extension sent for approval', invalidate: inv, silentError: true });
  const expire = useAction((reason: string) => api.post(`/contracts/${c.id}/let-expire`, { reason }), { success: `${c.contract_no} will be left to expire`, invalidate: inv });
  const term = useAction((reason: string) => api.post(`/contracts/${c.id}/terminate`, { reason }), { success: `${c.contract_no} terminated`, invalidate: inv });
  const inForce = ['Active', 'Expiring'].includes(c.status);
  const startFrom = c.valid_to >= new Date().toISOString().slice(0, 10) ? addDays(c.valid_to, 1) : new Date().toISOString().slice(0, 10);
  return (
    <>
      <Button size={size} variant="primary" icon={<RefreshCcw />} onClick={() => setDlg('renew')}>Renew</Button>
      {c.sap_oa_no && <Button size={size} icon={<CalendarPlus />} onClick={() => setDlg('extend')}>Extend validity</Button>}
      {inForce && <Button size={size} variant="ghost" icon={<Hourglass />} onClick={() => setDlg('expire')}>Let expire</Button>}
      {inForce && <Button size={size} variant="ghost" icon={<Ban />} onClick={() => setDlg('terminate')}>Terminate</Button>}
      <DatesDialog open={dlg === 'renew'} onClose={() => setDlg(null)} title={`Renew ${c.contract_no}`} confirm="Create renewal draft" error={renew.error}
        sub="Creates a draft copy with the same vendor, items and terms. Edit it if prices change, then send it for approval and SAP OA creation. It replaces this contract for routing once its OA syncs."
        from={startFrom} to={addDays(addDays(startFrom, 365), -1)} reasonOptional onSubmit={(b) => renew.run(b)} busy={renew.busy} />
      <DatesDialog open={dlg === 'extend'} onClose={() => setDlg(null)} title={`Extend ${c.contract_no} in SAP`} confirm="Send extension for approval" error={extend.error}
        sub={<>Current end date {fmtDate(c.valid_to)}. After approval the SAP team extends OA <span className="mono">{c.sap_oa_no}</span>; the new date applies when SAP syncs. <SimBadge>SAP simulator</SimBadge></>}
        to={addDays(c.valid_to, 180)} onSubmit={(b) => extend.run({ valid_to: b.valid_to, reason: b.reason })} busy={extend.busy} />
      <ReasonDialog open={dlg === 'expire'} onClose={() => setDlg(null)} title={`Let ${c.contract_no} expire`} confirmLabel="Record decision" sub={`No renewal. Reminders stop and the contract expires on ${fmtDate(c.valid_to)}; lines then route to RFQ.`} onSubmit={(r) => expire.run(r)} />
      <ReasonDialog open={dlg === 'terminate'} onClose={() => setDlg(null)} title={`Terminate ${c.contract_no}`} variant="danger" confirmLabel="Terminate contract" sub={c.sap_oa_no ? `PRs stop routing to it immediately. SAP/IT is asked to block OA ${c.sap_oa_no}.` : 'PRs stop routing to it immediately.'} onSubmit={(r) => term.run(r)} />
    </>
  );
}

function DatesDialog({ open, onClose, title, sub, confirm, from, to, onSubmit, busy, error, reasonOptional }: {
  open: boolean; onClose: () => void; title: string; sub: React.ReactNode; confirm: string; from?: string; to: string; busy: boolean; error: unknown; reasonOptional?: boolean;
  onSubmit: (b: { valid_from: string; valid_to: string; reason: string }) => Promise<unknown>;
}) {
  const [f, setF] = useState(from ?? '');
  const [t, setT] = useState(to);
  const [reason, setReason] = useState('');
  const ok = !!t && (reasonOptional || reason.trim().length >= 10) && (!from || (!!f && f < t));
  return (
    <Modal open={open} onClose={onClose} title={title} sub={sub} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!ok} onClick={() => onSubmit({ valid_from: f, valid_to: t, reason }).then(onClose).catch(() => undefined)}>{confirm}</Button></>}>
      <div className="stack">
        <ErrorSummary error={error} />
        <div className="form-grid">
          {from !== undefined && <Field label="Valid from" required><Input type="date" value={f} onChange={(e) => setF(e.target.value)} /></Field>}
          <Field label={from !== undefined ? 'Valid to' : 'New end date'} required><Input type="date" value={t} onChange={(e) => setT(e.target.value)} /></Field>
        </div>
        <Field label="Reason" required={!reasonOptional} hint={reasonOptional ? 'Optional. Recorded in the audit trail.' : 'At least 10 characters. Shown to the approver.'}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  );
}
