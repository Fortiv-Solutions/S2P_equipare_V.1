/**
 * PDF of a comparative statement (FR-CMP-08). When `locked` is true the document is the approved,
 * locked copy stored for the SAP PO record; otherwise it carries a "not approved" watermark line.
 */
import PDFDocument from 'pdfkit';
import { all, get } from '../../core/db.ts';
import type { ComparisonRow } from './service.ts';

const money = (n: number | null | undefined) => (n == null ? '-' : 'INR ' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(n));
const pct = (n: number | null | undefined) => (n == null ? '-' : `${(n * 100).toFixed(1)}%`);
const ist = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : '-');

export function renderPdf(c: ComparisonRow, locked: boolean): Promise<Buffer> {
  const rfq = get<{ rfq_no: string; title: string | null; plant: string | null; closed_at: string | null }>('SELECT rfq_no, title, plant, closed_at FROM rfqs WHERE id = ?', c.rfq_id);
  const approvals = all<{ id: number; req_no: string; type: string; status: string; decided_at: string | null; matrix_version: number | null }>(
    "SELECT id, req_no, type, status, decided_at, matrix_version FROM approvals WHERE object_type = 'comparison' AND object_id = ? ORDER BY id", c.id,
  );
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, info: { Title: `${c.cmp_no} v${c.version} comparative statement`, Author: 'Equipcare S2P' } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 64;
  const ensure = (h: number) => { if (doc.y + h > doc.page.height - 40) doc.addPage(); };

  doc.fillColor('#082D53').fontSize(16).font('Helvetica-Bold').text('Comparative statement and award recommendation');
  doc.moveDown(0.2).fontSize(9).font('Helvetica').fillColor('#36404c')
    .text(`${c.cmp_no} version ${c.version} - RFQ ${rfq?.rfq_no ?? c.rfq_id}${rfq?.title ? ` - ${rfq.title}` : ''} - Plant ${rfq?.plant ?? '-'} - Status ${c.status}`);
  doc.text(locked ? `Approved and locked copy generated ${ist(new Date().toISOString())}. This document must not be edited.` : 'NOT APPROVED - working copy for review only.', { continued: false });
  const lc = c.params.landed_cost;
  doc.text(`Landed cost = Taxable x (1 + gamma x GST) - PTA - LD - RD; Taxable = P(1-d)q + F + K. GST impact: ${lc.gst_impact}; payment-term adjustment ${lc.payment_term_adjustment.enabled ? `on (${lc.payment_term_adjustment.rate_pct}% , ref ${lc.payment_term_adjustment.reference_days} d)` : 'off'}; Ex-Works freight estimate ${lc.exw_freight_estimate_pct || 0}% (DEC-21).`);
  const cov = c.summary?.coverage;
  if (cov) doc.text(`Coverage: ${cov.responded} of ${cov.invited} invited vendors responded, ${cov.declined} declined, ${cov.non_participating} non-participating (${cov.vendors.filter((v) => v.status !== 'Responded').map((v) => `${v.name}: ${v.status}`).join('; ') || 'none'}).`);
  doc.moveDown(0.6);

  const cols = [{ h: 'Vendor', w: 0.2 }, { h: 'Basic', w: 0.08 }, { h: 'Disc %', w: 0.05 }, { h: 'GST %', w: 0.05 }, { h: 'Freight', w: 0.08 }, { h: 'Packing', w: 0.07 }, { h: 'Landed', w: 0.11 }, { h: 'Unit landed', w: 0.1 }, { h: 'vs LPP', w: 0.06 }, { h: 'Days', w: 0.05 }, { h: 'Rank', w: 0.05 }, { h: 'Award', w: 0.1 }];
  const row = (vals: string[], bold = false, fill?: string) => {
    ensure(16);
    const y = doc.y;
    if (fill) doc.rect(32, y - 2, W, 14).fill(fill);
    let x = 32;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#0d1b2a');
    vals.forEach((v, i) => { const w = cols[i].w * W; doc.text(v, x + 2, y, { width: w - 4, height: 12, ellipsis: true, lineBreak: false, align: i === 0 ? 'left' : 'right' }); x += w; });
    doc.x = 32;
    doc.y = y + 14;
  };
  for (const r of c.rows ?? []) {
    ensure(60);
    doc.moveDown(0.3).font('Helvetica-Bold').fontSize(10).fillColor('#082D53').text(`Line ${r.line_no}: ${r.description} - ${r.qty} ${r.uom ?? ''}${r.pr_ref ? ` - PR ${r.pr_ref}` : ''}`, 32);
    doc.font('Helvetica').fontSize(8).fillColor('#4e5866').text(`LPP ${money(r.lpp)} - Contract ${r.contract ? `${money(r.contract.unit_price)} (${r.contract.contract_no})` : 'none'} - Budget ${money(r.budget_price)} - ${r.gamma_basis.replace('γ', 'gamma')}`, 32);
    doc.moveDown(0.2);
    row(cols.map((x) => x.h), true, '#eceef1');
    for (const cell of r.cells) {
      const aw = (c.awards ?? []).find((a) => a.rfq_line_id === r.rfq_line_id && a.vendor_id === cell.vendor_id);
      if (cell.no_quote) { row([cell.vendor_name, 'No quote', '', '', '', '', '', '', '', '', '', aw ? 'Awarded' : '']); continue; }
      row([
        `${cell.vendor_name}${cell.alternate ? ' (alt)' : ''}${cell.partial ? ' (partial)' : ''}`, money(cell.basic_price), String(cell.discount_pct ?? 0), String(cell.gst_rate ?? 0),
        money(cell.freight), money(cell.packing), money(cell.landed), money(cell.unit_landed), pct(cell.var_lpp_pct), String(cell.delivery_days ?? '-'),
        cell.rank ? `${cell.rank}${cell.lowest ? ' L1' : ''}` : cell.alt_rank ? `alt ${cell.alt_rank}` : '-', aw ? `${aw.qty} ${r.uom ?? ''}` : '',
      ], !!aw, cell.lowest ? '#fdf1cc' : undefined);
    }
  }
  ensure(80);
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(11).fillColor('#082D53').text('Recommendation', 32);
  const rec = c.summary?.recommendation;
  doc.font('Helvetica').fontSize(9).fillColor('#0d1b2a');
  if (rec) doc.text(`Recommended by ${rec.by_name} on ${ist(rec.at)}. Total awarded landed cost ${money(rec.total_landed)}; lowest landed for the same quantities ${money(rec.lowest_total)}; difference ${money(rec.difference)}.`);
  if (c.justification) doc.text(`Justification: ${c.justification}`);
  if (c.deviation_reason) doc.text(`Deviation from lowest landed cost: ${c.deviation_reason}`);
  for (const s of rec?.skipped ?? []) doc.text(`Not awarded - line ${c.rows?.find((r) => r.rfq_line_id === s.rfq_line_id)?.line_no}: ${s.reason}`);
  ensure(60);
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(11).fillColor('#082D53').text('Approvals', 32);
  doc.font('Helvetica').fontSize(9).fillColor('#0d1b2a');
  for (const a of approvals) {
    const steps = all<{ level: number; approver_role: string; status: string; acted_at: string | null; name: string | null; comment: string | null; device: string | null }>(
      'SELECT s.level, s.approver_role, s.status, s.acted_at, s.comment, s.device, u.name FROM approval_steps s LEFT JOIN users u ON u.id = s.acted_by WHERE s.approval_id = ? ORDER BY s.level, s.id', a.id,
    );
    doc.text(`${a.req_no} (${a.type}, matrix version ${a.matrix_version ?? 'fallback'}): ${a.status}${a.decided_at ? ` ${ist(a.decided_at)}` : ''}`);
    for (const s of steps) doc.text(`   Level ${s.level} ${s.approver_role}: ${s.status}${s.name ? ` by ${s.name}` : ''}${s.acted_at ? ` ${ist(s.acted_at)}` : ''}${s.device ? ` (${s.device})` : ''}${s.comment ? ` - "${s.comment}"` : ''}`);
  }
  doc.moveDown(0.6).fontSize(7).fillColor('#6b7685').text('Generated by the Equipcare Source-to-Pay platform. The purchase order is created and released in SAP (DEC-05); this statement is the approval record attached to it.', 32);
  doc.end();
  return done;
}
