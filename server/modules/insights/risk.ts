/**
 * Delivery-risk scoring for open PO lines.
 *
 * Deterministic and explainable: every point in the score comes from a named factor shown to the buyer. There is no
 * model and no hidden weighting. The weights are a proposed default (config `insights.risk_bands`) and the result is
 * a prompt for the buyer to act, not a decision: the one-click action sends the same portal reminder the PO screen
 * sends today, and every use is logged (see ./log.ts).
 */
import { all, daysBetween, now } from '../../core/db.ts';
import { cfg } from '../../core/config.ts';
import * as PO from '../po/service.ts';
import { receivedLines } from '../reports/defs.ts';

export interface RiskFactor { label: string; points: number }
export interface RiskAction {
  type: 'remind' | 'escalate' | 'call' | 'monitor';
  /** Reminder type the one-click action sends (only for type 'remind'). */
  reminder?: PO.ReminderType;
  label: string;
  why: string;
}
export interface LineRisk {
  line_id: number; po_id: number; po_no: string; item: number; vendor_id: number; vendor: string; plant: string; description: string;
  urgency: string; score: number; band: 'High' | 'Medium' | 'Low'; factors: RiskFactor[];
  open_qty: number; uom: string; commitment: string; overdue_days: number; ack_status: string;
  action: RiskAction; preview: { title: string; body: string } | null; link: string;
}

export const riskBands = () => cfg<{ high: number; medium: number }>('insights.risk_bands');
const bandOf = (score: number): LineRisk['band'] => { const b = riskBands(); return score >= b.high ? 'High' : score >= b.medium ? 'Medium' : 'Low'; };

interface Fu { kind: string; created_at: string; meta: { level?: number } | null }

/** Vendor on-time record over fully received lines (same basis as KPI-07). Needs a few lines before it counts. */
function vendorRecord() {
  const m = new Map<number, { n: number; ok: number }>();
  for (const l of receivedLines()) {
    const x = m.get(l.vendor_id) ?? { n: 0, ok: 0 };
    x.n++;
    if (l.on_time) x.ok++;
    m.set(l.vendor_id, x);
  }
  return m;
}

/** Scored open PO lines, highest risk first. Pass `poId` for one PO. */
export function poLineRisks(opts: { poId?: number } = {}): LineRisk[] {
  const t = now().slice(0, 10);
  const pos = all<PO.PoRow & { vendor: string }>(
    `SELECT p.*, v.name AS vendor FROM pos p JOIN vendors v ON v.id = p.vendor_id WHERE p.status IN ('Published','Partially received') AND p.sap_released = 1 ${opts.poId ? 'AND p.id = ?' : ''}`,
    ...(opts.poId ? [opts.poId] : []),
  );
  const rec = vendorRecord();
  const out: LineRisk[] = [];
  for (const po of pos) {
    const cs = PO.cycleStart(po);
    const fus = all<Fu>('SELECT kind, created_at, meta_json FROM po_followups WHERE po_id = ? ORDER BY created_at, id', po.id);
    const asn = (all<{ n: number }>("SELECT COUNT(*) AS n FROM asns WHERE po_id = ? AND status IN ('Submitted','In transit','Delivered')", po.id)[0]?.n ?? 0) > 0;
    const reminders = fus.filter((f) => f.kind === 'Reminder' && f.created_at >= cs);
    const lastReminder = reminders.at(-1)?.created_at ?? null;
    const vendorSpoke = lastReminder ? fus.some((f) => f.kind === 'Vendor update' && f.created_at > lastReminder) : false;
    const level = fus.filter((f) => f.kind === 'Escalation' && f.created_at >= cs).reduce((m, f) => Math.max(m, Number(f.meta?.level ?? 0)), 0);
    const r = rec.get(po.vendor_id);
    for (const l of PO.linesOf(po.id)) {
      const s = PO.lineState(l, po, { asn });
      if (!s.active || s.open_qty <= 0) continue;
      const pending = PO.PENDING_ACK.includes(l.ack_status);
      const f: RiskFactor[] = [];
      const add = (label: string, points: number) => { if (points > 0) f.push({ label, points }); };
      if (s.overdue) add(`${s.overdue_days} day${s.overdue_days === 1 ? '' : 's'} past the committed date`, Math.min(45, 15 + s.overdue_days * 3));
      else if (!pending && !asn) {
        const d = daysBetween(t, s.commitment);
        if (d <= 3) add(`Due in ${Math.max(0, d)} day${d === 1 ? '' : 's'} with no dispatch (ASN) yet`, 20);
        else if (d <= 7) add(`Due in ${d} days with no dispatch (ASN) yet`, 10);
      }
      if (pending) add(s.ack_overdue ? 'Acknowledgement is overdue' : 'Not acknowledged yet', s.ack_overdue ? 25 : 8);
      if (l.ack_status === 'Partially accepted') add('Vendor accepted only part of the quantity', 15);
      if (l.first_commit_date && l.commit_date && l.commit_date > l.first_commit_date) {
        const slip = daysBetween(l.first_commit_date, l.commit_date);
        add(`Commitment already moved by ${slip} day${slip === 1 ? '' : 's'}`, Math.min(20, 5 + slip));
      }
      if (reminders.length >= 2 && !vendorSpoke) add(`${reminders.length} reminders with no vendor update`, 10);
      if (r && r.n >= 5) {
        const rate = r.ok / r.n;
        if (rate < 0.7) add(`Vendor delivered ${Math.round(rate * 100)}% of its last ${r.n} lines on time`, 15);
        else if (rate < 0.85) add(`Vendor delivered ${Math.round(rate * 100)}% of its last ${r.n} lines on time`, 8);
      }
      if (['BD', 'Urgent', 'Class 1'].includes(po.urgency)) add(`${po.urgency} order`, 10);
      if (level > 0) add(`Already escalated to level ${level}`, 5);
      const score = Math.min(100, f.reduce((a, x) => a + x.points, 0));
      if (score === 0) continue;

      const reminderToday = !!lastReminder && daysBetween(lastReminder, now()) < 1;
      let action: RiskAction;
      if (pending && reminderToday) action = { type: 'monitor', label: 'Reminder sent today', why: 'Give the vendor until tomorrow to acknowledge before chasing again.' };
      else if (pending) action = { type: 'remind', reminder: 'ack', label: 'Send acknowledgement reminder', why: 'The vendor has not accepted this line, so there is no delivery date to hold them to.' };
      else if (s.overdue && reminders.length >= 2 && level === 0 && s.overdue_days >= 7) action = { type: 'escalate', label: 'Escalate to the buyer’s manager', why: `Already ${reminders.length} reminders and ${s.overdue_days} days late with no escalation.` };
      else if (s.overdue && reminderToday) action = { type: 'call', label: 'Call the vendor', why: 'A reminder went out today. Get a firm date by phone and log it.' };
      else if (s.overdue) action = { type: 'remind', reminder: 'overdue', label: 'Send overdue reminder', why: 'Past the committed date. Ask for dispatch or a new date with a reason.' };
      else if (!asn && daysBetween(t, s.commitment) <= 7 && reminderToday) action = { type: 'monitor', label: 'Reminder sent today', why: 'Give the vendor until tomorrow to dispatch before chasing again.' };
      else if (!asn && daysBetween(t, s.commitment) <= 7) action = { type: 'remind', reminder: 'dispatch', label: 'Send dispatch reminder', why: 'Due soon and no ASN yet. Ask the vendor to dispatch and submit the ASN.' };
      else action = { type: 'monitor', label: 'Keep an eye on it', why: 'No action is needed yet.' };

      out.push({
        line_id: l.id, po_id: po.id, po_no: po.po_no, item: l.item, vendor_id: po.vendor_id, vendor: po.vendor, plant: po.plant, description: l.description,
        urgency: po.urgency, score, band: bandOf(score), factors: f.sort((a, b) => b.points - a.points), open_qty: s.open_qty, uom: l.uom, commitment: s.commitment,
        overdue_days: s.overdue_days, ack_status: l.ack_status, action,
        preview: action.type === 'remind' && action.reminder ? PO.reminderContent(action.reminder, po.po_no, String(l.item), s.commitment) : null,
        link: `/pos/${po.id}`,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.po_no.localeCompare(b.po_no));
}
