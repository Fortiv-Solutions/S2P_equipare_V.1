/**
 * Plain-language explanation of why an invoice is held and what to do next.
 *
 * The findings come from the 3-way match engine in invoices/service.ts (rules and finance-approved tolerances; no model).
 * This layer only turns each finding into "what it means / what to do / who owns it" and picks a recommended next step.
 * An optional model may reword the one-paragraph summary from those facts; the steps below always come from the rules.
 */
import { all, daysBetween, get, now } from '../../core/db.ts';
import { notFound } from '../../core/http.ts';
import { plantAllowed, type Actor } from '../../core/auth.ts';
import { aiStatus, wordSummary, type AiSource } from '../../core/ai.ts';
import type { ExceptionRow, InvoiceRow } from '../invoices/service.ts';

export type NextKind = 'wait' | 'reject' | 'correct' | 'resolve' | 'assign' | 'approve';
interface Guide { what: string; steps: string[]; next: NextKind; waits?: boolean }

const OWNER: Record<string, string> = { FIN: 'Finance', BUY: 'Buyer', STO: 'Stores', APR: 'Procurement manager', VEN: 'Vendor' };

/** Guidance per finding. Keyed by rule, refined by the finding's reason where one rule produces several outcomes. */
export function guideFor(e: Pick<ExceptionRow, 'rule' | 'reason' | 'line_item' | 'owner_role'>): Guide {
  const reason = e.reason ?? '';
  const item = e.line_item ? ` for item ${e.line_item}` : '';
  switch (e.rule) {
    case 'DUP':
      return { what: 'The vendor has already sent an invoice with this number.', steps: ['Do not process this copy.', 'Reject it to the vendor as a duplicate.'], next: 'reject' };
    case 'FIELD_MISSING':
    case 'OCR_CONF':
      return { what: 'The text reader could not read a field with enough confidence.', steps: ['Compare the field with the invoice document.', 'Correct it with a reason. The correction is kept in the audit trail.'], next: 'correct' };
    case 'GSTIN':
    case 'BUYER_GSTIN':
      return { what: 'A GSTIN on the invoice does not pass the check against the vendor or the receiving plant.', steps: ['Check the GSTIN against the vendor master and the plant registration.', 'If the invoice is wrong, reject it so the vendor sends a corrected one.'], next: 'reject' };
    case 'PO_VENDOR':
      return { what: 'The invoice does not line up with the PO it was submitted against.', steps: ['Confirm the invoice belongs to this PO.', 'If it belongs to another PO, reject it. If the PO is missing an item, ask the buyer to amend the PO.'], next: 'assign' };
    case 'BANK':
      return { what: 'The bank details on the invoice differ from the vendor master in SAP.', steps: ['Do not pay to the account on the invoice.', 'Call the vendor on a number from the SAP master and confirm the account before any change is made in SAP.'], next: 'assign' };
    case 'DISPUTE_HOLD':
      return { what: 'A receipt dispute on this PO holds the invoice.', steps: ['No finance action is needed. The invoice releases when the dispute is resolved or closed.', 'Chase the dispute owner if it is ageing.'], next: 'wait', waits: true };
    case '3WM-01':
      if (reason === 'Payment terms differ') return { what: 'The payment terms on the invoice differ from the PO. SAP pays on PO terms.', steps: ['No change is normally needed.', 'Approve the exception with a note if you agree.'], next: 'approve' };
      return { what: `The invoice value${item} does not add up or does not match the PO rate.`, steps: ['Check quantity × rate on the document.', 'If the reader got it wrong, correct the field. If the vendor billed wrongly, reject for a corrected invoice.'], next: 'correct' };
    case '3WM-02':
      if (reason.startsWith('Pending')) return { what: `The goods or service receipt${item} is not posted in SAP yet.`, steps: ['Nothing to do now. The invoice re-matches when SAP posts the receipt.', 'If it has waited several days, ask Stores at the plant to post it.'], next: 'wait', waits: true };
      return { what: `The vendor billed more than was received${item}.`, steps: ['Pay only what was received.', 'Ask the vendor for a credit note for the excess, or wait for the balance to be received.'], next: 'resolve' };
    case '3WM-03':
      return { what: 'The receipt was posted against a different PO line or material than the one billed.', steps: ['Ask Stores to check the receipt was posted to the right PO line.', 'Reject the invoice if the vendor billed the wrong item.'], next: 'assign' };
    case '3WM-04':
      return { what: `The GST rate, HSN/SAC or tax amount${item} does not match the PO and material master.`, steps: ['Check HSN and GST on the material master and the PO.', 'If the invoice is wrong, ask for a corrected invoice. If the master is wrong, have it fixed in SAP first.'], next: 'reject' };
    case '3WM-05':
      return { what: 'The invoice carries charges that are not in the PO terms.', steps: ['The buyer confirms whether the charge was agreed.', 'If agreed, approve the deviation with a reason. If not, ask the vendor to remove it.'], next: 'approve' };
    default:
      return { what: 'The match found a difference that needs a decision.', steps: ['Review the finding, then resolve it, approve it within your authority, or reject the invoice to the vendor.'], next: 'resolve' };
  }
}

const money = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const SEV = { high: 3, medium: 2, low: 1 } as Record<string, number>;

export interface InvoiceExplanation {
  invoice_id: number; inv_ref: string; status: string; headline: string; summary: string; source: AiSource; model?: string;
  recommended: { next: NextKind | 'none'; step: string } | null;
  items: {
    id: number; rule: string; reason: string; severity: string; owner: string; what: string; steps: string[]; next: NextKind; waits: boolean;
    message: string; expected: string | null; actual: string | null; tolerance: string | null; age_days: number; vendor_message: string;
  }[];
  ai: { mode: string; note: string };
}

/** Explain the open findings of an invoice. Resolves with rules text; an enabled model may reword the summary. */
export async function explainInvoice(actor: Actor, invId: number): Promise<InvoiceExplanation> {
  const inv = get<InvoiceRow>('SELECT * FROM invoices WHERE id = ?', invId);
  if (!inv) throw notFound('Invoice');
  const po = get<{ po_no: string; plant: string }>('SELECT po_no, plant FROM pos WHERE id = ?', inv.po_id);
  if (!po || !plantAllowed(actor, po.plant)) throw notFound('Invoice');
  const vendor = get<{ name: string }>('SELECT name FROM vendors WHERE id = ?', inv.vendor_id)?.name ?? 'The vendor';
  const open = all<ExceptionRow>("SELECT * FROM invoice_exceptions WHERE invoice_id = ? AND status = 'Open' ORDER BY id", invId);
  const items = open.map((e) => {
    const g = guideFor(e);
    return {
      id: e.id, rule: e.rule, reason: e.reason, severity: e.severity, owner: OWNER[e.owner_role] ?? e.owner_role, what: g.what, steps: g.steps, next: g.next, waits: !!g.waits,
      message: e.message, expected: e.expected, actual: e.actual, tolerance: e.tolerance, age_days: Math.max(0, daysBetween(e.created_at, now())), vendor_message: e.vendor_message,
    };
  }).sort((a, b) => (SEV[b.severity] ?? 0) - (SEV[a.severity] ?? 0));

  const blocking = items.filter((i) => !i.waits);
  const lead = blocking[0] ?? items[0];
  const ref = inv.vendor_invoice_no ?? inv.inv_ref;
  let headline: string;
  let recommended: InvoiceExplanation['recommended'] = null;
  let summary: string;
  if (!items.length) {
    headline = inv.status === 'Matched' ? 'No open issues. This invoice matched.' : `No open issues. Status: ${inv.status}.`;
    summary = headline;
  } else if (items.some((i) => i.rule === 'DUP')) {
    headline = 'This looks like a duplicate. Do not process it.';
    recommended = { next: 'reject', step: guideFor({ rule: 'DUP', reason: '', line_item: null, owner_role: 'FIN' }).steps[1] };
    summary = `${vendor} invoice ${ref} (${money(inv.total_value)}) on PO ${po.po_no} repeats an invoice number already received from this vendor. ${recommended.step}`;
  } else if (!blocking.length) {
    headline = 'Nothing for you to do. This invoice is waiting on someone else.';
    recommended = { next: 'wait', step: items[0].steps[0] };
    summary = `${vendor} invoice ${ref} (${money(inv.total_value)}) on PO ${po.po_no} is held: ${[...new Set(items.map((i) => i.reason))].join('; ')}. ${items[0].steps[0]}`;
  } else {
    headline = `${blocking.length} issue${blocking.length === 1 ? '' : 's'} to resolve before this invoice can move.`;
    recommended = { next: lead.next, step: lead.steps[0] };
    summary = `${vendor} invoice ${ref} (${money(inv.total_value)}) on PO ${po.po_no} has ${items.length} open issue${items.length === 1 ? '' : 's'}: ${[...new Set(items.map((i) => i.reason))].join('; ')}. Start with “${lead.reason}”: ${lead.steps[0]}`;
  }

  let source: AiSource = 'rules';
  let model: string | undefined;
  if (items.length) {
    const facts = { vendor, invoice: ref, total: inv.total_value, po: po.po_no, status: inv.status, issues: items.map((i) => ({ reason: i.reason, owner: i.owner, expected: i.expected, actual: i.actual, age_days: i.age_days })), recommended_first_step: recommended?.step };
    const worded = await wordSummary(facts, 'Explain why this invoice is held and what the reader should do first.');
    if (worded) { summary = worded.text; source = 'model'; model = worded.model; }
  }
  const st = aiStatus();
  return { invoice_id: inv.id, inv_ref: inv.inv_ref, status: inv.status, headline, summary, source, model, recommended, items, ai: { mode: st.mode, note: st.note } };
}
