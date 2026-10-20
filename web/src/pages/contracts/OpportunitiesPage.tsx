import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Play, Eye, Check, X, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtLakh, fmtMoney } from '@/lib/format';
import { Button, ButtonLink, Callout, Card, DecisionTag, Empty, KV, Kpi, LoadingBlock, PageHeader, Ref, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Drawer, ReasonDialog } from '@/components/overlay';
import { Field } from '@/components/forms';

interface Opp {
  id: number; material_id: number; material_code: string; description: string; uom: string; category: string | null; category_name: string | null; frequency: number;
  annual_value: number; vendor_count: number; current_coverage: string; suggested_action: string; status: string; decision_reason: string | null;
  decided_by_name: string | null; decided_at: string | null; identified_at: string; contract_id: number | null; contract_no: string | null; contract_status: string | null; lookback_days: number;
}

export default function OpportunitiesPage() {
  const { can } = useAuth();
  const q = useQuery<Opp[]>({ queryKey: ['contracts', 'opportunities'], queryFn: () => api.get('/contracts/opportunities') });
  const [open, setOpen] = useState<Opp | null>(null);
  const [rejecting, setRejecting] = useState<Opp | null>(null);
  const run = useAction(() => api.post<{ message: string }>('/contracts/opportunities/run'), { success: (r) => `Detection finished: ${r.message}`, invalidate: [['contracts']] });
  const review = useAction((id: number) => api.post(`/contracts/opportunities/${id}/review`), { success: 'Marked under review', invalidate: [['contracts']] });
  const reject = useAction((id: number, reason: string) => api.post(`/contracts/opportunities/${id}/reject`, { reason }), { success: 'Opportunity rejected', invalidate: [['contracts']], onSuccess: () => setOpen(null) });
  const rows = q.data ?? [];
  const live = rows.filter((r) => ['Identified', 'Under review'].includes(r.status));
  const columns: Column<Opp>[] = [
    { key: 'material_code', header: 'Material', render: (r) => <div style={{ minWidth: 200 }}><div style={{ fontWeight: 600 }}>{r.description}</div><div className="small subtle mono">{r.material_code} · {r.category_name ?? r.category}</div></div>, value: (r) => `${r.material_code} ${r.description}` },
    { key: 'frequency', header: 'POs in look-back', align: 'right' },
    { key: 'annual_value', header: 'Annual value', align: 'right', render: (r) => fmtLakh(r.annual_value) },
    { key: 'vendor_count', header: 'Vendors', align: 'right' },
    { key: 'current_coverage', header: 'Current coverage', render: (r) => <span className="small">{r.current_coverage}</span> },
    { key: 'suggested_action', header: 'Suggested action', render: (r) => <span className="small" style={{ maxWidth: 260, display: 'inline-block' }}>{r.suggested_action}</span> },
    { key: 'status', header: 'Status', render: (r) => <div className="stack-sm" style={{ gap: 2 }}><Status value={r.status} />{r.contract_no && <Ref to={`/contracts/${r.contract_id}`}>{r.contract_no}</Ref>}</div> },
    { key: 'actions', header: '', sortable: false, exportable: false, render: (r) => <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>Open</Button> },
  ];
  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/contracts">Contracts</Link><span>/</span><span>Opportunities</span></>} screen="SCR-CON-03" title="ARC / OA opportunities"
        sub={<>Materials bought repeatedly without a valid contract, from SAP PO history. Thresholds are proposed defaults <DecisionTag id="DEC-09" />.</>}
        actions={can('con.manage') && <Button variant="deep" icon={<Play />} loading={run.busy} onClick={run.fire}>Run detection now</Button>}
      />
      <div className="grid-3" style={{ marginBottom: 20 }}>
        <Kpi label="Open opportunities" value={q.data ? live.length : '—'} meta="Identified or under review" />
        <Kpi label="Annual spend not on contract" value={q.data ? fmtLakh(live.reduce((s, r) => s + r.annual_value, 0)) : '—'} meta={`Look-back ${rows[0]?.lookback_days ?? 365} days`} />
        <Kpi label="Accepted — sourcing started" value={q.data ? rows.filter((r) => r.status === 'Accepted').length : '—'} />
      </div>
      <Card flush>
        <DataTable id="contract-opportunities" rows={q.data} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.id} onRowClick={setOpen} columns={columns}
          filters={[{ key: 'status', label: 'Status', value: (r) => r.status }, { key: 'category', label: 'Category', value: (r) => r.category_name ?? r.category }]}
          initialSort={{ key: 'annual_value', dir: 'desc' }}
          empty={<Empty title="No opportunities above the thresholds" action={can('con.manage') ? <Button variant="deep" onClick={run.fire}>Run detection now</Button> : undefined}>The daily job checks PO history for repeat purchases without an ARC/OA.</Empty>}
          mobile={{ title: (r) => <><span className="mono">{r.material_code}</span> · {r.description}</>, badge: (r) => <Status value={r.status} />, meta: (r) => [`${r.frequency} POs`, fmtLakh(r.annual_value), `${r.vendor_count} vendor(s)`] }}
        />
      </Card>
      {open && <OppDrawer opp={rows.find((r) => r.id === open.id) ?? open} onClose={() => setOpen(null)} onReview={(id) => review.fire(id)} onReject={(o) => setRejecting(o)} canManage={can('con.manage')} />}
      <ReasonDialog open={!!rejecting} onClose={() => setRejecting(null)} title={`Reject opportunity for ${rejecting?.material_code}`} variant="danger" confirmLabel="Reject opportunity" onSubmit={(r) => reject.run(rejecting!.id, r)} />
    </>
  );
}

function OppDrawer({ opp, onClose, onReview, onReject, canManage }: { opp: Opp; onClose: () => void; onReview: (id: number) => void; onReject: (o: Opp) => void; canManage: boolean }) {
  const d = useQuery<Opp & { history: { po_id: number; po_no: string; po_date: string; plant: string; vendor: string; vendor_id: number; qty: number; unit_price: number; value: number }[] }>({ queryKey: ['contracts', 'opportunity', opp.id], queryFn: () => api.get(`/contracts/opportunities/${opp.id}`) });
  const [vendor, setVendor] = useState('');
  const accept = useAction(() => api.post<{ contract_id: number; contract_no: string; rfq_link: string }>(`/contracts/opportunities/${opp.id}/accept`, vendor ? { vendor_id: Number(vendor) } : {}), { success: (r) => `Accepted — draft ARC ${r.contract_no} created`, invalidate: [['contracts']] });
  const vendors = [...new Map((d.data?.history ?? []).map((h) => [h.vendor_id, h.vendor])).entries()];
  const live = ['Identified', 'Under review'].includes(opp.status);
  return (
    <Drawer open onClose={onClose} title={`${opp.material_code} — ${opp.description}`}
      footer={canManage && live ? (
        <>
          {opp.status === 'Identified' && <Button icon={<Eye />} onClick={() => onReview(opp.id)}>Mark under review</Button>}
          <Button variant="danger" icon={<X />} onClick={() => onReject(opp)}>Reject</Button>
          <Button variant="primary" icon={<Check />} loading={accept.busy} onClick={accept.fire}>Accept and start sourcing</Button>
        </>
      ) : undefined}>
      <div className="stack">
        <Status value={opp.status} />
        <KV items={[['Purchase frequency', `${opp.frequency} POs in ${opp.lookback_days} days`], ['Annual value', fmtMoney(opp.annual_value, true)], ['Vendors used', opp.vendor_count], ['Current coverage', opp.current_coverage], ['Suggested action', opp.suggested_action], ['Identified', fmtDate(opp.identified_at)]]} />
        {opp.status === 'Rejected' && <Callout tone="bad" title={`Rejected by ${opp.decided_by_name ?? '—'}`}>{opp.decision_reason}</Callout>}
        {opp.status === 'Accepted' && opp.contract_id && (
          <Callout tone="ok" title="Sourcing started">
            Draft ARC <Ref to={`/contracts/${opp.contract_id}`}>{opp.contract_no}</Ref> is prefilled for this material. Run the annual-rate RFQ, then update prices and send the ARC for approval.
            <div className="row-wrap" style={{ marginTop: 8 }}><ButtonLink to={`/rfqs/new?opportunity=${opp.id}`} size="sm" variant="primary" icon={<Send size={14} />}>Start annual-rate RFQ</ButtonLink><ButtonLink to={`/contracts/${opp.contract_id}`} size="sm">Open draft ARC</ButtonLink></div>
          </Callout>
        )}
        {canManage && live && vendors.length > 1 && (
          <Field label="Prefill the draft ARC with vendor" hint="Defaults to the vendor with the highest spend.">
            <select className="select" value={vendor} onChange={(e) => setVendor(e.target.value)}><option value="">Highest-spend vendor</option>{vendors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
          </Field>
        )}
        <strong>Purchase history</strong>
        {d.isLoading ? <LoadingBlock rows={3} /> : (
          <div className="tbl-wrap"><table className="tbl tbl--dense">
            <thead><tr><th>PO</th><th>Date</th><th>Vendor</th><th className="num">Qty</th><th className="num">Price</th></tr></thead>
            <tbody>{d.data?.history.map((h) => <tr key={`${h.po_no}-${h.qty}-${h.unit_price}`}><td><Ref to={`/pos/${h.po_id}`}>{h.po_no}</Ref></td><td>{fmtDate(h.po_date)}</td><td>{h.vendor}</td><td className="num">{h.qty}</td><td className="num">{fmtMoney(h.unit_price)}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
    </Drawer>
  );
}
