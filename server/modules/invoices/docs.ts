/**
 * Document rendering for Modules 10/11: demo invoice files (seed), photographed-invoice images (seed),
 * and payment advice PDFs (FR-PAY-04). pdfkit output is collected synchronously from its buffer.
 */
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';

export function pdfSync(build: (doc: PDFKit.PDFDocument) => void): Buffer {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'Equipcare S2P document' } });
  build(doc);
  doc.end();
  const chunks: Buffer[] = [];
  let c: Buffer | null;
  while ((c = doc.read() as Buffer | null) !== null) chunks.push(c);
  return Buffer.concat(chunks);
}

const inr = (n: number | null | undefined) => (n == null ? '—' : `Rs ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export interface InvoiceDoc {
  vendor: string; vendorAddress: string; header: Record<string, string | number | null>; lines: Record<string, string | number | null>[]; billTo: string;
}

/** A vendor tax invoice as the vendor would have printed it (demo data only). */
export function invoicePdf(d: InvoiceDoc) {
  return pdfSync((doc) => {
    const h = d.header;
    doc.font('Helvetica-Bold').fontSize(16).text(d.vendor);
    doc.font('Helvetica').fontSize(9).fillColor('#444').text(d.vendorAddress).text(`GSTIN: ${h.vendor_gstin ?? ''}`);
    doc.moveDown(0.6).fillColor('#000').font('Helvetica-Bold').fontSize(13).text('TAX INVOICE', { align: 'right' });
    doc.font('Helvetica').fontSize(9).text(`Invoice no.: ${h.invoice_no}`, { align: 'right' }).text(`Date: ${h.invoice_date}`, { align: 'right' }).text(`PO no.: ${h.po_no}`, { align: 'right' });
    if (h.eway_bill) doc.text(`E-way bill: ${h.eway_bill}`, { align: 'right' });
    doc.moveDown(0.6).font('Helvetica-Bold').text('Bill to').font('Helvetica').text(d.billTo).text(`GSTIN: ${h.buyer_gstin ?? ''}`);
    doc.moveDown(0.8);
    const cols = [48, 80, 250, 310, 350, 420, 470];
    const y0 = doc.y;
    doc.font('Helvetica-Bold').fontSize(8);
    ['Item', 'Description', 'HSN/SAC', 'Qty', 'Rate', 'GST %', 'Amount'].forEach((t, i) => doc.text(t, cols[i], y0, { width: (cols[i + 1] ?? 547) - cols[i] - 4 }));
    doc.moveTo(48, y0 + 12).lineTo(547, y0 + 12).stroke('#999');
    let y = y0 + 16;
    doc.font('Helvetica').fontSize(8);
    for (const l of d.lines) {
      const cells = [String(l.po_item ?? ''), String(l.description ?? ''), String(l.hsn ?? ''), String(l.qty ?? ''), inr(Number(l.rate)), `${l.gst_rate ?? ''}`, inr(Number(l.taxable_value))];
      cells.forEach((t, i) => doc.text(t, cols[i], y, { width: (cols[i + 1] ?? 547) - cols[i] - 4 }));
      y += 26;
    }
    doc.moveTo(48, y).lineTo(547, y).stroke('#999');
    doc.y = y + 8;
    const tot = (label: string, v: unknown) => doc.font(label === 'Invoice total' ? 'Helvetica-Bold' : 'Helvetica').text(`${label}: ${inr(Number(v ?? 0))}`, 300, doc.y, { width: 247, align: 'right' });
    tot('Taxable value', h.taxable_value);
    tot('GST', h.gst_amount);
    if (Number(h.freight ?? 0)) tot('Freight', h.freight);
    if (Number(h.other_charges ?? 0)) tot('Other charges', h.other_charges);
    tot('Invoice total', h.total_value);
    doc.moveDown(1.2).font('Helvetica').fontSize(8).text(`Payment terms: ${h.payment_terms ?? '—'}`, 48).text(`Bank: A/c ${h.bank_account ?? '—'} · IFSC ${h.bank_ifsc ?? '—'}`, 48);
    doc.moveDown(2).fillColor('#888').fontSize(7).text('Fictional demo document generated for the Equipcare S2P MVP.', 48);
  });
}

/** A "photographed" invoice: a grey, slightly skewed paper image with text bars (PNG, demo only). */
export function photoPng(nonce: number, w = 420, hgt = 560) {
  const raw = Buffer.alloc((w + 1) * hgt);
  let seed = 1234567 + nonce * 7919;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < hgt; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const edge = x < 24 || x > w - 24 || y < 20 || y > hgt - 20;
      let v = edge ? 70 + rnd() * 20 : 205 + rnd() * 20 - y / 30;
      const row = Math.floor((y - 60) / 22);
      const inBar = !edge && y > 60 && (y - 60) % 22 < 8 && x > 48 + ((row * 37) % 30) && x < w - 60 - ((row * 53) % 140) && row < 20;
      if (inBar) v = 60 + rnd() * 40;
      if (!edge && y > 24 && y < 48 && x > 48 && x < 220) v = 40;
      raw[y * (w + 1) + 1 + x] = Math.max(0, Math.min(255, v));
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(hgt, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0Phone photo ${nonce}`)), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface AdviceDoc {
  vendor: string; vendorCode: string | null; invRef: string; vendorInvoiceNo: string | null; invoiceDate: string | null; poNo: string;
  rows: [string, string][]; deductions: { label: string; amount: number }[] | null; generatedFor: string;
}

/** Payment advice (FR-PAY-04) — only fields SAP provided and the viewer may see. */
export function advicePdf(d: AdviceDoc) {
  return pdfSync((doc) => {
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#082D53').text('Knowteq Equipcare LLP');
    doc.font('Helvetica').fontSize(9).fillColor('#444').text('Payment advice — Source-to-Pay platform');
    doc.moveDown(1).fillColor('#000').font('Helvetica-Bold').fontSize(11).text(`To: ${d.vendor}${d.vendorCode ? ` (vendor ${d.vendorCode})` : ''}`);
    doc.font('Helvetica').fontSize(9).text(`Invoice ${d.vendorInvoiceNo ?? '—'} dated ${d.invoiceDate ?? '—'} · platform ref ${d.invRef} · PO ${d.poNo}`);
    doc.moveDown(0.8);
    for (const [k, v] of d.rows) {
      const y = doc.y;
      doc.font('Helvetica').fillColor('#555').text(k, 48, y, { width: 200 });
      doc.font('Helvetica-Bold').fillColor('#000').text(v, 260, y, { width: 287 });
      doc.moveDown(0.4);
    }
    if (d.deductions?.length) {
      doc.moveDown(0.4).font('Helvetica-Bold').text('Deductions', 48);
      for (const x of d.deductions) doc.font('Helvetica').text(`${x.label}: ${inr(x.amount)}`, 60);
    }
    doc.moveDown(2).fontSize(7).fillColor('#888').text(`Payment executed in SAP; status and amounts synchronised through INT-M12 (SAP simulator in this MVP). Generated for ${d.generatedFor}.`, 48);
  });
}
