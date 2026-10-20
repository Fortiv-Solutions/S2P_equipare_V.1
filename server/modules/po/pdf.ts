/** PO document (FR-POM-01): generated on demand from the synchronised SAP PO with pdfkit. */
import PDFDocument from 'pdfkit';
import type { PoDetail } from './service.ts';

const NAVY = '#082D53';
const AMBER = '#F4B719';
const STEEL = '#5B6B7F';
const LINE = '#D5DCE4';

const money = (n: number | null | undefined) => (n == null ? '—' : `Rs ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const date = (d?: string | null) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export function poPdf(d: PoDetail): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Purchase order ${d.po_no} v${d.version}`, Author: 'Knowteq Equipcare LLP' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width;
    const L = 40;
    const R = W - 40;

    // Header band
    doc.rect(0, 0, W, 86).fill(NAVY);
    doc.rect(0, 86, W, 4).fill(AMBER);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(20).text('EQUIPCARE', L, 24);
    doc.font('Helvetica').fontSize(9).fillColor('#C9D6E4').text('Knowteq Equipcare LLP · Source-to-Pay', L, 50);
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#FFFFFF').text('PURCHASE ORDER', L, 24, { width: R - L, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(AMBER).text(`${d.po_no}  ·  Version ${d.version}`, L, 46, { width: R - L, align: 'right' });
    doc.fillColor('#C9D6E4').fontSize(9).text(`PO date ${date(d.po_date)}  ·  ${d.status}${d.urgency && d.urgency !== 'General stock' ? `  ·  ${d.urgency}` : ''}`, L, 62, { width: R - L, align: 'right' });

    // Parties
    let y = 108;
    const col = (x: number, w: number, title: string, rows: string[]) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(STEEL).text(title.toUpperCase(), x, y, { width: w, characterSpacing: 0.8 });
      doc.font('Helvetica').fontSize(9.5).fillColor('#111827');
      let yy = y + 13;
      for (const r of rows.filter(Boolean)) { doc.text(r, x, yy, { width: w }); yy = doc.y + 1; }
      return yy;
    };
    const v = d.vendor as Record<string, any>;
    const p = d.plant_info;
    const colW = (R - L - 30) / 3;
    const y1 = col(L, colW, 'Vendor', [String(v.name ?? ''), `Vendor code ${v.sap_code ?? '—'}`, v.gstin ? `GSTIN ${v.gstin}` : '', [v.address, v.city].filter(Boolean).join(', ')]);
    const y2 = col(L + colW + 15, colW, 'Ship to / plant', [p ? `${p.name} (${p.code})` : d.plant, p?.ship_to_address ?? '', p?.gstin ? `GSTIN ${p.gstin}` : '']);
    const y3 = col(L + 2 * (colW + 15), colW, 'Terms', [`Payment: ${d.payment_terms ?? '—'}`, `Delivery: ${d.delivery_terms ?? '—'}`, `Freight: ${d.freight_terms ?? '—'}`, d.buyer ? `Buyer: ${d.buyer.name}` : '', d.contract ? `${d.contract.type} ${d.contract.sap_oa_no ?? d.contract.contract_no}` : '']);
    y = Math.max(y1, y2, y3) + 14;

    // Lines table
    const cols = [
      { h: 'Item', w: 34, a: 'left' as const },
      { h: 'Material / description', w: 178, a: 'left' as const },
      { h: 'Qty', w: 50, a: 'right' as const },
      { h: 'Rate', w: 70, a: 'right' as const },
      { h: 'GST', w: 34, a: 'right' as const },
      { h: 'Delivery', w: 62, a: 'right' as const },
      { h: 'Amount', w: R - L - 34 - 178 - 50 - 70 - 34 - 62, a: 'right' as const },
    ];
    const row = (vals: string[], bold = false, fill?: string) => {
      const h = Math.max(...vals.map((t, i) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).heightOfString(t, { width: cols[i].w - 6 }))) + 8;
      if (y + h > doc.page.height - 120) { doc.addPage(); y = 50; }
      if (fill) doc.rect(L, y, R - L, h).fill(fill);
      let x = L;
      vals.forEach((t, i) => { doc.fillColor(fill === NAVY ? '#FFFFFF' : '#111827').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).text(t, x + 3, y + 4, { width: cols[i].w - 6, align: cols[i].a }); x += cols[i].w; });
      y += h;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(0.5).stroke();
    };
    row(cols.map((c) => c.h), true, NAVY);
    for (const l of d.lines) {
      const cancelled = l.status === 'Cancelled';
      row([
        String(l.item),
        `${l.material_code ?? ''}${l.hsn ? ` · HSN ${l.hsn}` : ''}\n${l.description}${cancelled ? ' (cancelled)' : ''}`,
        `${l.qty} ${l.uom}`, money(l.unit_price), `${l.gst_rate}%`, date(l.delivery_date), cancelled ? '—' : money(l.line_value),
      ]);
    }
    y += 8;
    const t = d.totals;
    const tot = (label: string, val: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10.5 : 9).fillColor(bold ? NAVY : '#111827');
      doc.text(label, R - 250, y, { width: 140, align: 'right' });
      doc.text(val, R - 105, y, { width: 105, align: 'right' });
      y += bold ? 18 : 14;
    };
    if (t) {
      tot('Goods value', money(t.goods));
      tot('GST', money(t.gst));
      tot('Freight', money(t.freight));
      doc.moveTo(R - 250, y).lineTo(R, y).strokeColor(NAVY).lineWidth(1).stroke();
      y += 5;
      tot(`Total (${d.currency})`, money(t.total), true);
    }
    y += 12;
    if (y > doc.page.height - 170) { doc.addPage(); y = 50; }
    doc.font('Helvetica-Bold').fontSize(8).fillColor(STEEL).text('TERMS AND CONDITIONS', L, y, { characterSpacing: 0.8 });
    y += 13;
    const terms = [
      'Acknowledge every line on the Equipcare vendor portal with accepted quantity and delivery commitment date.',
      'Quote the PO number and item on the ASN, delivery challan and tax invoice. Invoices are matched to this PO and the goods receipt.',
      `Delivery terms: ${d.delivery_terms ?? 'as agreed'}. Payment terms: ${d.payment_terms ?? 'as agreed'}.`,
      'Any change in quantity, price or date is valid only through an amended PO version issued by Equipcare.',
    ];
    doc.font('Helvetica').fontSize(8.5).fillColor('#111827');
    terms.forEach((s, i) => { doc.text(`${i + 1}. ${s}`, L, y, { width: R - L }); y = doc.y + 3; });

    const fy = doc.page.height - 56;
    doc.moveTo(L, fy).lineTo(R, fy).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(STEEL).text(
      `PO ${d.po_no} version ${d.version}. SAP is the system of record; this document is generated by the platform from the released SAP PO (SAP simulator in this MVP). Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      L, fy + 6, { width: R - L },
    );
    doc.end();
  });
}
