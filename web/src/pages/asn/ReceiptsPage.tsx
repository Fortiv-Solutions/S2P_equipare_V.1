import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardX, FileText, PackageCheck, Truck, Warehouse } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDate, fmtNum, plural } from '@/lib/format';
import { Badge, ButtonLink, Card, Empty, ErrorState, Kpi, LoadingBlock, PageHeader, Ref, SimBadge, Status } from '@/components/ui';
import { Select } from '@/components/forms';
import { TermBadge } from './shared';
import type { AsnListRow } from './types';

type Bucket = 'today' | 'week' | 'overdue' | 'received' | 'later';
interface ReceiptRow extends Omit<AsnListRow, 'lines'> {
  bucket: Bucket; plant_name: string;
  lines: { po_line_id: number; item: number; qty: number; description: string; uom: string; material_code: string | null; ordered: number; received: number }[];
}
interface Receipts { rows: ReceiptRow[]; plants: { code: string; name: string }[]; counts: Record<Bucket, number>; can_post_grn: boolean; can_raise: boolean }

const LABEL: Record<Bucket, string> = { today: 'Today', week: 'Next 7 days', overdue: 'Overdue', received: 'Received (7 days)', later: 'Later' };

/** SCR-ASN-03 — stores expected receipts by plant and date; the primary phone screen at the dock (FR-ASN-05). */
export default function ReceiptsPage() {
  const [sp, setSp] = useSearchParams();
  const plant = sp.get('plant') ?? '';
  const q = useQuery<Receipts>({ queryKey: ['asn', 'receipts', plant], queryFn: () => api.get('/asn/receipts', { plant: plant || undefined }), refetchInterval: 60_000 });
  const c = q.data?.counts;
  const bucket = (sp.get('when') as Bucket) ?? (c ? (c.today ? 'today' : c.overdue ? 'overdue' : 'week') : 'today');
  const set = (k: string, v: string) => { if (v) sp.set(k, v); else sp.delete(k); setSp(sp, { replace: true }); };
  const rows = (q.data?.rows ?? []).filter((r) => r.bucket === bucket);

  return (
    <>
      <PageHeader title="Expected receipts" screen="SCR-ASN-03" eyebrow="Stores"
        sub="Consignments vendors have dispatched to your plants, from their ASNs. Check the material against the ASN, post the GRN in SAP, and record any shortage or damage here."
        actions={q.data && q.data.plants.length > 1 ? <Select aria-label="Plant" value={plant} onChange={(e) => set('plant', e.target.value)} options={[{ value: '', label: 'All my plants' }, ...q.data.plants.map((p) => ({ value: p.code, label: `${p.code} · ${p.name}` }))]} style={{ minWidth: 220 }} /> : undefined} />
      <div className="grid-4" style={{ marginBottom: 18 }}>
        {(['today', 'week', 'overdue', 'received'] as Bucket[]).map((b) => (
          <Kpi key={b} label={LABEL[b]} value={c?.[b] ?? '—'} tone={b === 'overdue' && c?.overdue ? 'bad' : undefined} onClick={() => set('when', b)} meta={bucket === b ? 'Showing' : undefined} />
        ))}
      </div>
      {q.isLoading ? <LoadingBlock rows={6} /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : rows.length === 0 ? (
        <Card><Empty title={`Nothing ${bucket === 'received' ? 'received in the last 7 days' : bucket === 'overdue' ? 'overdue' : `expected ${LABEL[bucket].toLowerCase()}`}`} icon={<Warehouse size={24} />}>
          {bucket === 'today' && c?.week ? `${plural(c.week, 'consignment')} expected in the next 7 days.` : 'Consignments appear here when vendors submit ASNs for your plants.'}
        </Empty></Card>
      ) : (
        <div className="stack">
          {rows.map((r) => <ReceiptCard key={r.id} r={r} canPost={!!q.data?.can_post_grn} canRaise={!!q.data?.can_raise} />)}
        </div>
      )}
    </>
  );
}

function ReceiptCard({ r, canPost, canRaise }: { r: ReceiptRow; canPost: boolean; canRaise: boolean }) {
  const open = r.status !== 'Delivered';
  return (
    <section className="card">
      <div className="card__body stack" style={{ gap: 12 }}>
        <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div className="row-wrap"><Ref to={`/asns/${r.id}`}>{r.asn_no}</Ref><Status value={r.pickup_overdue ? 'Pickup overdue' : r.status} /><TermBadge term={r.delivery_terms} />{r.open_disputes > 0 && <Badge tone="bad">{r.open_disputes} open dispute{r.open_disputes > 1 ? 's' : ''}</Badge>}</div>
            <h3 style={{ marginTop: 4, fontSize: 'var(--fs-16)' }}>{r.vendor_name}</h3>
            <div className="small muted">PO <span className="mono">{r.po_no}</span> · {r.plant} · {open ? <>expected <strong>{fmtDate(r.expected_date)}</strong></> : <>GRN <span className="mono">{r.grn_nos ?? '—'}</span></>}</div>
          </div>
          <div className="small muted" style={{ textAlign: 'right' }}>
            <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}><Truck size={14} aria-hidden />{r.pickup_by === 'Equipcare' ? `Equipcare pickup · ${r.pickup_status ?? 'Requested'}` : r.transporter ?? 'Transporter not given'}</div>
            {r.lr_no && <div>LR <span className="mono">{r.lr_no}</span></div>}
            {r.vehicle_no && <div>Vehicle <span className="mono">{r.vehicle_no}</span></div>}
          </div>
        </div>
        <ul className="list-plain" style={{ borderTop: '1px solid var(--steel-100)' }}>
          {r.lines.map((l) => (
            <li key={l.po_line_id} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--steel-100)', gap: 10 }}>
              <div style={{ minWidth: 0 }}><span className="mono subtle">{l.item}</span> {l.description}{l.material_code && <span className="small subtle mono"> · {l.material_code}</span>}</div>
              <div className="num" style={{ whiteSpace: 'nowrap' }}><strong>{fmtNum(l.qty)}</strong> {l.uom}{!open && <span className="small subtle"> · rec. {fmtNum(l.received)}/{fmtNum(l.ordered)}</span>}</div>
            </li>
          ))}
        </ul>
        <div className="row-wrap between">
          <span className="small muted"><FileText size={13} aria-hidden /> {plural(r.doc_count, 'document')}{r.eway_bill ? ` · e-way bill ${r.eway_bill}` : ''}{r.invoice_ref ? ` · invoice ${r.invoice_ref}` : ''}</span>
          <div className="row-wrap">
            <ButtonLink to={`/asns/${r.id}`} size="sm" variant="ghost">View ASN</ButtonLink>
            {canRaise && <ButtonLink to={`/disputes/new?asn=${r.id}`} size="sm" icon={<ClipboardX size={14} />}>Record receipt issue</ButtonLink>}
          </div>
        </div>
        {canPost && open && (
          <div className="sim-panel row-wrap between">
            <span className="small"><SimBadge>SAP simulator</SimBadge> Post the GRN for the accepted quantity in SAP (MIGO). The simulator stands in for SAP here.</span>
            <ButtonLink to={`/sap-simulator?action=grn&po=${r.po_no}&asn=${r.id}`} size="sm" variant="deep" icon={<PackageCheck size={14} />}>Post GRN in SAP simulator</ButtonLink>
          </div>
        )}
      </div>
    </section>
  );
}
