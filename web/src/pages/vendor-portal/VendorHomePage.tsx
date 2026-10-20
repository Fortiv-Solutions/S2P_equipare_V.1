/** SCR-VPT-01 vendor home. */
import { Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { daysUntil, fmtDate, fmtDateTime, fmtMoney, ago } from '@/lib/format';
import { Badge, Callout, Card, Kpi, Loader, PageHeader, Status } from '@/components/ui';

export default function VendorHomePage() {
  const { me } = useAuth();
  const q = useQuery<any>({ queryKey: ['vendor-home'], queryFn: () => api.get('/vendors/me/home'), refetchInterval: 60_000 });
  return (
    <>
      <PageHeader title={`Welcome, ${me?.name.split(' ')[0] ?? ''}`} screen="SCR-VPT-01" sub={me?.vendor ? `${me.vendor.name}${me.vendor.sap_code ? ` · vendor code ${me.vendor.sap_code}` : ''}` : undefined} />
      <Loader q={q} rows={8}>{(h) => (h.active ? <Home h={h} /> : <Navigate to="/vendor/onboarding" replace />)}</Loader>
    </>
  );
}

function Tile({ title, to, count, tone, children, empty, all }: { title: string; to: string; count: number; tone?: 'warn' | 'bad'; children?: React.ReactNode; empty: string; all?: string }) {
  return (
    <Card title={<div className="row-wrap"><h2>{title}</h2>{count > 0 && <Badge tone={tone ?? 'info'}>{count}</Badge>}</div>} actions={all ? <Link to={to} className="small">{all}</Link> : undefined}>
      {count === 0 ? <p className="small muted" style={{ margin: 0 }}>{empty}</p> : <ul className="list-plain stack-sm">{children}</ul>}
    </Card>
  );
}
const Row = ({ to, main, sub, right }: { to: string; main: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode }) => (
  <li>
    <Link to={to} className="row between" style={{ gap: 12, padding: '6px 0', borderBottom: '1px solid var(--steel-100)', color: 'inherit', textDecoration: 'none' }}>
      <span style={{ minWidth: 0 }}><span style={{ fontWeight: 600 }}>{main}</span>{sub && <span className="small muted" style={{ display: 'block' }}>{sub}</span>}</span>
      <span className="small" style={{ flex: 'none' }}>{right}</span>
    </Link>
  </li>
);

function Home({ h }: { h: any }) {
  const expired = h.documents.filter((d: any) => d.status === 'Expired' || d.expiry_date < h.today);
  return (
    <div className="stack">
      {h.vendor.sap_blocked ? <Callout tone="bad" title="Your vendor code is blocked in SAP">You keep access to open invoices and payments but receive no new RFQs or purchase orders. Raise a ticket or contact your buyer.</Callout> : null}
      {expired.length > 0 && <Callout tone="bad" title="A mandatory document has expired">{expired.map((d: any) => d.doc_type).join(', ')} — upload the renewed document so new RFQ invitations are not paused. <Link to="/vendor/profile">Open profile & documents</Link></Callout>}
      <div className="grid-4">
        <Kpi label="RFQs to answer" value={h.rfqs.length} tone={h.rfqs.length ? 'warn' : undefined} to="/vendor/rfqs" />
        <Kpi label="POs to acknowledge" value={h.pos.length} tone={h.pos.length ? 'warn' : undefined} to="/vendor/pos" />
        <Kpi label="Invoices with exceptions" value={h.invoices.length} tone={h.invoices.length ? 'bad' : undefined} to="/vendor/invoices" />
        <Kpi label="Disputes awaiting you" value={h.disputes.length} tone={h.disputes.length ? 'bad' : undefined} to="/vendor/disputes" />
      </div>
      <div className="grid-2">
        <Tile title="Open RFQs to answer" to="/vendor/rfqs" count={h.rfqs.length} all="All RFQs" empty="No RFQs are waiting for your quotation.">
          {h.rfqs.map((r: any) => <Row key={r.id} to={`/vendor/rfqs/${r.id}`} main={<><span className="mono">{r.rfq_no}</span> {r.title}</>} sub={`Closes ${fmtDateTime(r.closing_at)}`} right={<Status value={r.invitation_status} />} />)}
        </Tile>
        <Tile title="Purchase orders to acknowledge" to="/vendor/pos" count={h.pos.length} all="All POs" empty="Every released PO is acknowledged.">
          {h.pos.map((p: any) => <Row key={p.id} to={`/vendor/pos/${p.id}`} main={<span className="mono">{p.po_no}</span>} sub={`${fmtDate(p.po_date)} · ${p.plant} · ${p.pending} line(s) pending`} right={fmtMoney(p.total_value, true)} />)}
        </Tile>
        <Tile title="Dispatch due (ASN)" to="/vendor/asns" count={h.asn_due.length} tone="warn" all="Dispatch" empty="No dispatches are due in the next 7 days.">
          {h.asn_due.map((a: any) => <Row key={`${a.id}-${a.item}`} to={`/vendor/pos/${a.id}`} main={<><span className="mono">{a.po_no}/{a.item}</span> {a.description}</>} sub={`${a.open_qty} ${a.uom} open`} right={<span style={{ color: a.due < h.today ? 'var(--bad)' : undefined, fontWeight: 600 }}>{a.due < h.today ? 'Overdue ' : 'Due '}{fmtDate(a.due)}</span>} />)}
        </Tile>
        <Tile title="Invoices with exceptions" to="/vendor/invoices" count={h.invoices.length} tone="bad" all="All invoices" empty="No invoice needs your attention.">
          {h.invoices.map((i: any) => <Row key={i.id} to={`/vendor/invoices/${i.id}`} main={<><span className="mono">{i.inv_ref}</span> {i.vendor_invoice_no}</>} sub={i.vendor_reason ?? 'Equipcare is reviewing this invoice.'} right={fmtMoney(i.total_value, true)} />)}
        </Tile>
        <Tile title="Recent payments" to="/vendor/payments" count={h.payments.length} all="All payments" empty="No payments released yet.">
          {h.payments.map((i: any) => <Row key={i.id} to={`/vendor/invoices/${i.id}`} main={<><span className="mono">{i.inv_ref}</span> {i.vendor_invoice_no}</>} sub={`Paid ${fmtDate(i.paid_at)}${i.payment_ref ? ` · ${i.payment_ref}` : ''}`} right={fmtMoney(i.total_value, true)} />)}
        </Tile>
        <Tile title="Disputes awaiting your response" to="/vendor/disputes" count={h.disputes.length} tone="bad" all="All disputes" empty="No disputes need your response.">
          {h.disputes.map((d: any) => <Row key={d.id} to={`/vendor/disputes/${d.id}`} main={<><span className="mono">{d.dsp_no}</span> {d.type}</>} sub={`PO ${d.po_no}`} right={<Status value={d.status} />} />)}
        </Tile>
        <Tile title="Documents expiring" to="/vendor/profile" count={h.documents.length} tone="warn" all="Profile & documents" empty="All your documents are current.">
          {h.documents.map((d: any) => { const days = daysUntil(d.expiry_date) ?? 0; return <Row key={d.id} to="/vendor/profile" main={d.doc_type} sub={`Expiry ${fmtDate(d.expiry_date)}`} right={<span style={{ color: days < 0 ? 'var(--bad)' : 'var(--warn)', fontWeight: 600 }}>{days < 0 ? `Expired ${-days} d ago` : `${days} d left`}</span>} />; })}
        </Tile>
        <Tile title="Your tickets" to="/vendor/tickets" count={h.tickets.length} all="All tickets" empty="No tickets need your attention.">
          {h.tickets.map((t: any) => <Row key={t.id} to={`/vendor/tickets/${t.id}`} main={<><span className="mono">{t.tkt_no}</span> {t.subject}</>} sub={`Updated ${ago(t.updated_at)}`} right={<Status value={t.status} />} />)}
        </Tile>
      </div>
      {h.vendor.performance_score != null && <p className="small muted">Score and scorecard visibility are pending Equipcare decision DEC-22, so the score is not shown here.</p>}
    </div>
  );
}
