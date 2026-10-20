import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { api, downloadUrl } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { Badge, ButtonLink, Callout, Card, KV, Loader, PageHeader, Status } from '@/components/ui';
import { OcrNote } from './shared';

interface V {
  id: number; inv_ref: string; vendor_invoice_no: string | null; invoice_date: string | null; status: string; on_behalf: number; created_at: string; total_value: number | null; taxable_value: number | null; gst_amount: number | null; freight: number;
  po: { id: number; po_no: string; po_date: string; plant: string }; values: { header: Record<string, string | number | null>; lines: Record<string, string | number | null>[] } | null;
  rejected_reason: string | null; payment_blocked_reason: string | null; exceptions: { id: number; vendor_message: string; status: string; line_item: number | null; created_at: string }[];
  events: { id: number; status: string | null; title: string; created_at: string }[]; attachment: { id: number; filename: string; mime: string } | null;
}

/** SCR-VPT-07 detail — status timeline and vendor-safe reasons only (GOV-C08, DEC-19). */
export default function VendorInvoicePage() {
  const id = Number(useParams().id);
  const q = useQuery<V>({ queryKey: ['invoices', 'vendor-detail', id], queryFn: () => api.get(`/invoices/vendor/${id}`) });
  return <Loader q={q} rows={8}>{(d) => <View d={d} />}</Loader>;
}

function View({ d }: { d: V }) {
  const open = d.exceptions.filter((e) => e.status === 'Under review');
  const needsFix = d.status === 'Rejected' || d.status === 'Exception';
  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/vendor/invoices">Invoices</Link><span>/</span><span className="mono">{d.inv_ref}</span></>} screen="SCR-VPT-07"
        title={<>Invoice {d.vendor_invoice_no ?? d.inv_ref}</>} badges={<><Status value={d.status} />{d.on_behalf ? <Badge tone="deep">Uploaded by Equipcare for you</Badge> : null}</>}
        sub={<>PO <span className="mono">{d.po.po_no}</span> · {fmtMoney(d.total_value)} · invoice date {fmtDate(d.invoice_date)} · received {fmtDateTime(d.created_at)}</>}
        actions={needsFix ? <ButtonLink to={`/vendor/invoices/upload?po=${d.po.id}`} variant="primary" icon={<Upload size={16} />}>Upload a corrected invoice</ButtonLink> : undefined}
      />
      <div className="split">
        <div className="stack">
          {d.status === 'Rejected' && <Callout tone="bad" title="Equipcare returned this invoice">{d.rejected_reason}</Callout>}
          {d.payment_blocked_reason && <Callout tone="warn" title="Payment is on hold">{d.payment_blocked_reason}</Callout>}
          {open.length > 0 && (
            <Card title="What needs attention">
              <ul className="stack-sm" style={{ margin: 0, paddingLeft: 18 }}>{open.map((e) => <li key={e.id}>{e.vendor_message}{e.line_item ? <span className="small subtle"> (item {e.line_item})</span> : null}</li>)}</ul>
              <p className="small muted" style={{ marginTop: 10 }}>Accounts is reviewing these. If a corrected invoice is needed they will tell you; payment follows the purchase order terms.</p>
            </Card>
          )}
          <Card title="Status timeline">
            <ol className="timeline">
              {d.events.map((e) => (
                <li key={e.id}><span className="timeline__dot" data-tone={/Rejected|hold|Exception/i.test(e.status ?? '') ? 'bad' : /released|Posted|Approved|Matched/i.test(`${e.status} ${e.title}`) ? 'ok' : undefined} aria-hidden /><div className="timeline__title">{e.title}</div><div className="timeline__meta">{fmtDateTime(e.created_at)}{e.status ? ` · ${e.status}` : ''}</div></li>
              ))}
            </ol>
          </Card>
          {d.values && (
            <Card title={<div className="row-wrap"><h2>Details we captured</h2><OcrNote compact /></div>}>
              <KV cols items={[['Invoice no.', d.values.header.invoice_no], ['Date', fmtDate(String(d.values.header.invoice_date ?? ''))], ['Taxable value', fmtMoney(d.taxable_value)], ['GST', fmtMoney(d.gst_amount)], ['Freight', d.freight ? fmtMoney(d.freight) : '—'], ['Total', fmtMoney(d.total_value)]]} />
              <div className="tbl-wrap" style={{ marginTop: 12 }}>
                <table className="tbl tbl--dense"><thead><tr><th>PO item</th><th>Description</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">GST</th></tr></thead>
                  <tbody>{d.values.lines.map((l, i) => <tr key={i}><td className="mono">{l.po_item}</td><td>{l.description}</td><td className="num">{l.qty}</td><td className="num">{fmtMoney(Number(l.rate))}</td><td className="num">{l.gst_rate}%</td></tr>)}</tbody></table>
              </div>
              <p className="small muted" style={{ marginTop: 8 }}>Simulated OCR — values come from the uploaded details; no OCR engine is connected.</p>
            </Card>
          )}
        </div>
        <div className="stack">
          <Card title="Your file">
            {d.attachment ? <div className="stack-sm"><p className="small" style={{ margin: 0 }}>{d.attachment.filename}</p><a className="btn btn--secondary" href={downloadUrl(`/files/${d.attachment.id}/download`)} target="_blank" rel="noreferrer"><Download size={16} /> Download</a></div> : <p className="muted small" style={{ margin: 0 }}>The file is not available.</p>}
          </Card>
          <Card title="Payment"><p className="small muted" style={{ margin: 0 }}>Once Equipcare releases payment, the status, payment reference and advice are on <Link to="/vendor/payments">Payments</Link>.</p></Card>
        </div>
      </div>
    </>
  );
}
