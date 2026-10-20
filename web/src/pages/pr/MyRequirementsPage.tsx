import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Button, Card, Empty, Freshness, Kpi, LoadingBlock, ErrorState, PageHeader, Priority, Status, Segmented } from '@/components/ui';
import { Drawer } from '@/components/overlay';
import { ThreadView } from '@/components/Thread';
import { TrackChain, prLineChain } from '@/components/TrackChain';

interface Req {
  id: number; ref: string; description: string; qty: number; uom: string; plant: string; required_date: string; priority: string; status: string; route: string | null;
  buyer_name: string | null; buyer_email: string | null; age_days: number; rfq_no: string | null; rfq_status: string | null; rfq_closing: string | null;
  expected_po_date: string | null; expected_po_basis: string | null; po_no: string | null; po_status: string | null; ack_status: string | null; commit_date: string | null;
  delivery_date: string | null; received_qty: number | null; delay_reason: string | null; asn_no: string | null; asn_status: string | null; asn_expected: string | null;
  flag: string | null; latest_remark: { body: string; at: string; by: string } | null;
}

/** SCR-PRW-04 — requisitioner's own lines: buyer, route, RFQ / PO / dispatch status, delay reason (PR-02, FR-POM-11). */
export default function MyRequirementsPage() {
  const q = useQuery<Req[]>({ queryKey: ['pr', 'mine'], queryFn: () => api.get('/pr/mine') });
  const [sp] = useSearchParams();
  const focus = Number(sp.get('focus'));
  const [filter, setFilter] = useState<'open' | 'delivered' | 'all'>('open');
  const [thread, setThread] = useState<Req | null>(null);
  useEffect(() => { if (focus && q.data) { const r = q.data.find((x) => x.id === focus); if (r) setTimeout(() => document.getElementById(`req-${r.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100); } }, [focus, q.data]);
  const rows = useMemo(() => (q.data ?? []).filter((r) => {
    const done = r.status === 'Closed' || (r.received_qty != null && r.received_qty >= r.qty);
    return filter === 'all' ? true : filter === 'delivered' ? done : !done;
  }), [q.data, filter]);
  const d = q.data ?? [];
  return (
    <>
      <PageHeader title="My requirements" screen="SCR-PRW-04" sub="Every PR line you raised in SAP: who is buying it, where it is, and when it is expected." badges={<Freshness flow="INT-M03" label="PRs" />}
        actions={<Segmented label="Show" value={filter} onChange={setFilter} options={[{ id: 'open', label: 'In progress' }, { id: 'delivered', label: 'Delivered / closed' }, { id: 'all', label: 'All' }]} />} />
      <div className="grid-4" style={{ marginBottom: 18 }}>
        <Kpi label="In progress" value={d.filter((r) => !['Closed'].includes(r.status) && !(r.received_qty != null && r.received_qty >= r.qty)).length} />
        <Kpi label="Waiting for a buyer" value={d.filter((r) => !r.buyer_name).length} tone={d.some((r) => !r.buyer_name) ? 'warn' : undefined} />
        <Kpi label="PO raised" value={d.filter((r) => r.po_no).length} />
        <Kpi label="Delayed by vendor" value={d.filter((r) => r.delay_reason).length} tone={d.some((r) => r.delay_reason) ? 'bad' : undefined} />
      </div>
      {q.isLoading ? <LoadingBlock rows={6} /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : rows.length === 0 ? (
        <Card><Empty title="No requirements in this view">Raise a PR in SAP. It appears here once SAP releases it and the platform synchronises.</Empty></Card>
      ) : (
        <div className="stack">
          {rows.map((r) => (
            <section key={r.id} id={`req-${r.id}`} className="card" style={{ outline: r.id === focus ? '2px solid var(--amber-500)' : undefined }}>
              <div className="card__body stack" style={{ gap: 12 }}>
                <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row-wrap"><span className="mono subtle">{r.ref}</span><Priority value={r.priority} /><Status value={r.status} /></div>
                    <h3 style={{ marginTop: 4, fontSize: 'var(--fs-16)' }}>{r.description}</h3>
                    <div className="small muted">{r.qty} {r.uom} · {r.plant} · needed by {fmtDate(r.required_date)} · {r.age_days} days in procurement</div>
                  </div>
                  <Button size="sm" icon={<MessageSquare />} onClick={() => setThread(r)}>Ask procurement</Button>
                </div>
                <TrackChain compact steps={prLineChain({ status: r.status, route: r.route, rfq_no: r.rfq_no, po_no: r.po_no, ack_status: r.ack_status, asn_status: r.asn_status, received_qty: r.received_qty, qty: r.qty })} />
                <dl className="kv kv--cols">
                  <div><dt>Buyer</dt><dd className="row" style={{ gap: 6 }}><UserRound size={14} aria-hidden />{r.buyer_name ?? 'Awaiting assignment'}</dd></div>
                  <div><dt>Route</dt><dd>{r.route ?? 'Being reviewed'}</dd></div>
                  <div><dt>RFQ</dt><dd>{r.rfq_no ? <>{r.rfq_no} · {r.rfq_status}</> : '—'}</dd></div>
                  <div><dt>{r.po_no ? 'PO' : 'Expected PO'}</dt><dd>{r.po_no ? <span className="mono">{r.po_no}</span> : r.expected_po_date ? <>{fmtDate(r.expected_po_date)} <span className="small subtle">({r.expected_po_basis})</span></> : 'Not yet estimated'}</dd></div>
                  <div><dt>Vendor commitment</dt><dd>{r.commit_date ? fmtDate(r.commit_date) : r.ack_status ?? '—'}</dd></div>
                  <div><dt>Dispatch</dt><dd>{r.asn_no ? <>{r.asn_status} · ETA {fmtDate(r.asn_expected)}</> : '—'}</dd></div>
                  <div><dt>Received</dt><dd>{r.received_qty != null ? `${r.received_qty} of ${r.qty} ${r.uom}` : '—'}</dd></div>
                  <div><dt>Delay reason</dt><dd style={{ color: r.delay_reason ? 'var(--bad)' : undefined }}>{r.delay_reason ?? '—'}</dd></div>
                </dl>
                {r.latest_remark && <p className="small muted">Latest remark from {r.latest_remark.by}: “{r.latest_remark.body}”</p>}
              </div>
            </section>
          ))}
        </div>
      )}
      {thread && <ClarifyDrawer req={thread} onClose={() => setThread(null)} />}
    </>
  );
}

function ClarifyDrawer({ req, onClose }: { req: Req; onClose: () => void }) {
  const q = useQuery<{ comments: { id: number; body: string; created_at: string; user_id: number; user_name: string }[] }>({ queryKey: ['pr', 'line', req.id], queryFn: () => api.get(`/pr/lines/${req.id}`) });
  const send = useAction((body: string) => api.post(`/pr/lines/${req.id}/clarify`, { body }), { success: 'Message sent to the buyer', invalidate: [['pr']] });
  return (
    <Drawer open onClose={onClose} title={`Clarification · ${req.ref}`}>
      <p className="small muted" style={{ marginBottom: 14 }}>{req.description}. {req.buyer_name ? `${req.buyer_name} is notified.` : 'The Procurement Manager is notified until a buyer is assigned.'}</p>
      {q.isLoading ? <LoadingBlock rows={3} /> : <ThreadView messages={q.data?.comments ?? []} onSend={(b) => send.run(b)} placeholder="Ask about status, specification or dates…" />}
    </Drawer>
  );
}
