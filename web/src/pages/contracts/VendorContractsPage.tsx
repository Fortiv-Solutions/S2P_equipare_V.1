/** Vendor portal: own contracts, read-only (PRD 6 matrix "V own"). */
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fmtDate, fmtMoney, fmtNum } from '@/lib/format';
import { Badge, Callout, Card, Empty, KV, Loader, PageHeader, Ref, Status } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { AttachmentList } from '@/components/Attachments';
import { UtilBar } from './shared';
import { TYPE_LABEL, type VmiStatus } from './types';

interface Row { id: number; contract_no: string; sap_oa_no: string | null; type: string; title: string | null; status: string; valid_from: string; valid_to: string; value_cap: number | null; utilisation_pct: number | null; scope: string; days_to_expiry: number; vmi_below_min: number }

export function VendorContractsPage() {
  const q = useQuery<Row[]>({ queryKey: ['contracts', 'vendor'], queryFn: () => api.get('/contracts/vendor') });
  return (
    <>
      <PageHeader title="Your contracts" screen="SCR-VPT-10" sub="Rate contracts, outline agreements, discount structures and VMI arrangements Equipcare holds with you. Read-only." />
      <Card flush>
        <DataTable id="vendor-contracts" rows={q.data} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.id} rowLink={(r) => `/vendor/contracts/${r.id}`}
          columns={[
            { key: 'sap_oa_no', header: 'Agreement', render: (r) => <div><Ref to={`/vendor/contracts/${r.id}`}>{r.sap_oa_no ?? r.contract_no}</Ref><div className="small subtle">{r.type}</div></div>, value: (r) => r.sap_oa_no ?? r.contract_no },
            { key: 'title', header: 'Title & scope', render: (r) => <div style={{ minWidth: 200 }}><div style={{ fontWeight: 600 }}>{r.title}</div><div className="small subtle mono">{r.scope}</div></div> },
            { key: 'valid_to', header: 'Validity', render: (r) => `${fmtDate(r.valid_from)} – ${fmtDate(r.valid_to)}` },
            { key: 'status', header: 'Status', render: (r) => <div className="row-wrap"><Status value={r.status} />{r.vmi_below_min > 0 && <Badge tone="bad">{r.vmi_below_min} below min</Badge>}</div> },
            { key: 'utilisation_pct', header: 'Utilisation', render: (r) => <UtilBar pct={r.utilisation_pct} /> },
          ]}
          empty={<Empty title="No contracts yet">Contracts appear here once they are set up in SAP.</Empty>}
          mobile={{ title: (r) => <><span className="mono">{r.sap_oa_no ?? r.contract_no}</span> · {r.title}</>, badge: (r) => <Status value={r.status} />, meta: (r) => [r.type, `to ${fmtDate(r.valid_to)}`, r.vmi_below_min ? `${r.vmi_below_min} item(s) below VMI minimum` : ''] }}
        />
      </Card>
    </>
  );
}

interface VDetail {
  id: number; contract_no: string; sap_oa_no: string | null; type: string; title: string | null; status: string; plant: string | null; valid_from: string; valid_to: string;
  value_cap: number | null; payment_terms: string | null; delivery_terms: string | null; discount_pct: number | null; terms: string | null; price_revision_date: string | null; days_to_expiry: number;
  items: { id: number; material_code: string; description: string; uom: string; unit_price: number; qty_cap: number | null; discount_pct: number | null; utilisation?: { consumed_qty: number; pct: number | null } }[];
  utilisation: { consumed: number; cap: number | null; pct: number | null; remaining: number | null };
  price_lists: { id: number; version: number; effective_from: string; state: string; note: string | null; items: { material_id: number; material_code: string; description: string; list_price: number }[] }[];
  vmi: { replenishment_frequency: string; billing_cycle: string; reconciliation: string; plant: string | null } | null;
  vmi_status: VmiStatus[];
  pos: { id: number; po_no: string; po_date: string; status: string; total_value: number }[];
}

export function VendorContractDetailPage() {
  const id = Number(useParams().id);
  const q = useQuery<VDetail>({ queryKey: ['contracts', 'vendor', id], queryFn: () => api.get(`/contracts/vendor/${id}`) });
  return <Loader q={q}>{(c) => (
    <>
      <PageHeader eyebrow={<><Link to="/vendor/contracts">Your contracts</Link><span>/</span><span className="mono">{c.sap_oa_no ?? c.contract_no}</span></>} screen="SCR-VPT-10"
        title={c.title ?? c.contract_no} badges={<><Status value={c.status} /><Badge tone="deep">{c.type}</Badge></>}
        sub={<>{TYPE_LABEL[c.type] ?? c.type} · {c.sap_oa_no ? <>SAP OA <span className="mono">{c.sap_oa_no}</span></> : 'being set up in SAP'} · valid {fmtDate(c.valid_from)} – {fmtDate(c.valid_to)}</>} />
      {c.vmi_status.some((v) => v.state === 'Below minimum') && <div style={{ marginBottom: 16 }}><Callout tone="bad" title="Replenishment needed">{c.vmi_status.filter((v) => v.state === 'Below minimum').map((v) => `${v.material_code}: stock ${v.unrestricted} ${v.uom} (min ${v.min}, max ${v.max})`).join(' · ')}</Callout></div>}
      <div className="split">
        <div className="stack">
          <Card title="Items and prices" flush>
            <DataTable id="vendor-contract-items" rows={c.items} rowKey={(r) => r.id} searchable={false} savedViews={false}
              columns={[
                { key: 'material_code', header: 'Material', render: (r) => <div><div style={{ fontWeight: 600 }}>{r.description}</div><div className="small subtle mono">{r.material_code}</div></div> },
                { key: 'unit_price', header: 'Contract price', align: 'right', render: (r) => `${fmtMoney(r.unit_price)} / ${r.uom}` },
                { key: 'discount_pct', header: 'Discount', align: 'right', render: (r) => ((r.discount_pct ?? c.discount_pct) != null ? `${r.discount_pct ?? c.discount_pct}%` : '—') },
                { key: 'qty_cap', header: 'Used / cap', align: 'right', render: (r) => (r.qty_cap != null ? `${fmtNum(r.utilisation?.consumed_qty)} / ${fmtNum(r.qty_cap)}` : 'No cap') },
              ]}
              mobile={{ title: (r) => <><span className="mono">{r.material_code}</span> · {r.description}</>, badge: (r) => <span>{fmtMoney(r.unit_price)}</span>, meta: (r) => [r.qty_cap != null ? `${fmtNum(r.utilisation?.consumed_qty)} of ${fmtNum(r.qty_cap)}` : 'No cap'] }} />
          </Card>
          {c.vmi && (
            <Card title="VMI stock status">
              <div className="tbl-wrap"><table className="tbl tbl--dense">
                <thead><tr><th>Material</th><th className="num">Stock</th><th className="num">Min</th><th className="num">Max</th><th>Status</th></tr></thead>
                <tbody>{c.vmi_status.map((v) => <tr key={v.material_id}><td><span className="mono">{v.material_code}</span></td><td className="num">{v.unrestricted} {v.uom}</td><td className="num">{v.min}</td><td className="num">{v.max}</td><td><Badge tone={v.state === 'Below minimum' ? 'bad' : v.state === 'Above maximum' ? 'warn' : 'ok'}>{v.state}</Badge></td></tr>)}</tbody>
              </table></div>
              <div style={{ marginTop: 12 }}><KV items={[['Replenishment', c.vmi.replenishment_frequency], ['Billing cycle', c.vmi.billing_cycle], ['Reconciliation', c.vmi.reconciliation]]} /></div>
            </Card>
          )}
          {c.price_lists.length > 0 && (
            <Card title="Price-list versions">
              <div className="stack-sm">{c.price_lists.map((p) => <div key={p.id} className="row-wrap between"><span><strong>v{p.version}</strong> from {fmtDate(p.effective_from)} <Badge tone={p.state === 'Current' ? 'ok' : 'neutral'}>{p.state}</Badge></span><span className="small muted">{p.items.map((i) => `${i.material_code} ${fmtMoney(i.list_price)}`).join(' · ')}</span></div>)}</div>
            </Card>
          )}
          <Card title="Documents"><AttachmentList ownerType="contract" ownerId={c.id} /></Card>
        </div>
        <div className="stack">
          <Card title="Terms"><KV items={[['Payment terms', c.payment_terms], ['Delivery terms', c.delivery_terms], ['Discount', c.discount_pct != null ? `${c.discount_pct}%` : '—'], ['Price revision', fmtDate(c.price_revision_date)], ['Days to expiry', c.days_to_expiry >= 0 ? c.days_to_expiry : 'Ended']]} />{c.terms && <p className="small" style={{ marginTop: 10 }}>{c.terms}</p>}</Card>
          <Card title="Utilisation"><UtilBar pct={c.utilisation.pct} /><div style={{ marginTop: 10 }}><KV items={[['Consumed', fmtMoney(c.utilisation.consumed, true)], ['Value cap', c.utilisation.cap != null ? fmtMoney(c.utilisation.cap, true) : 'No cap']]} /></div></Card>
          <Card title="POs on this agreement">{c.pos.length ? <ul className="list-plain stack-sm">{c.pos.map((p) => <li key={p.id} className="row between"><Ref to={`/vendor/pos/${p.id}`}>{p.po_no}</Ref><span className="small muted">{fmtDate(p.po_date)} · <Status value={p.status} /></span></li>)}</ul> : <Empty title="No POs yet" />}</Card>
        </div>
      </div>
    </>
  )}</Loader>;
}
