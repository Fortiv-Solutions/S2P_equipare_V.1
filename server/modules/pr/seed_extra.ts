/**
 * Extended demo data for Module 1 (PR workbench).
 *
 * The SAP side (seed/base_extra.ts) delivers ~40 more open requisition lines. Here the assigned buyers run the stock / open-PO /
 * contract checks and decide the route for about fifty of the open lines: most confirmed (ARC/OA, VMI, FDS, fixed supplier,
 * RFQ, urgent, Class 1, service, capex), a few overrides that raise off-contract approvals (decided later by the approvals
 * seed), some on hold, some with clarification threads with the requisitioner and two closed. Every action goes through the
 * Module 1 service as the right persona; the domain rows are re-dated afterwards (the audit log is never touched).
 *
 * Lines reserved for other seeds (RFQ extras, direct exception approvals) are listed in those seeds; this plan only has to
 * leave them in a state they can start from, so each line appears once here at most.
 */
import { get, run, scalar, tx } from '../../core/db.ts';
import type { Actor } from '../../core/auth.ts';
import { actorFor, PRL } from '../../seed/ctx.ts';
import { ago, ageApproval } from '../approvals/seed_extra.ts';
import * as S from './service.ts';

type Step =
  | { do: 'confirm' }
  | { do: 'override'; route: S.RouteName; reason: string }
  | { do: 'hold'; reason: string }
  | { do: 'close'; reason: string }
  | { do: 'clarify'; thread: ['buyer' | 'req', string][]; then?: 'confirm' };

interface Item { ref: string; step: Step; ago?: number }

const confirm = (...refs: string[]): Item[] => refs.map((ref) => ({ ref, step: { do: 'confirm' } }));

const PLAN: Item[] = [
  // Contract routes (ARC/OA, VMI, FDS, fixed supplier) -> PO is created in SAP against the outline agreement.
  ...confirm('10045503/10', '10045503/20', '10046008/10', '10046007/10', '10045505/10', '10045505/20', '10045506/10', '10045506/20', '10045512/10', '10046001/10', '10046005/10'),
  // Overrides of a valid contract: off-contract approval (APP-04, CON-03). Decided by the approvals seed.
  { ref: '10046020/20', ago: 17, step: { do: 'override', route: 'RFQ', reason: 'ARC rate is above the current market for this bulk quantity; floating an RFQ to benchmark the price.' } },
  { ref: '10046013/10', ago: 11, step: { do: 'override', route: 'RFQ', reason: 'ARC holder quoted a five-week lead time against a two-week need; seeking alternate sources.' } },
  { ref: '10046023/10', ago: 0.6, step: { do: 'override', route: 'RFQ', reason: 'Local stockist has the item ready at the Nagpur plant; ARC supply would take two weeks.' } },
  { ref: '10046021/10', ago: 8, step: { do: 'override', route: 'RFQ', reason: 'Requisitioner needs the OEM-brand water pump; the ARC vendor supplies a non-OEM equivalent.' } },
  // Single-source exception route.
  { ref: '10046024/10', ago: 2.2, step: { do: 'override', route: 'Exception', reason: 'Hydraulic bearing puller is OEM-specific tooling available only through the Komatsu distributor; single-source purchase.' } },
  // On hold.
  { ref: '10045490/10', step: { do: 'hold', reason: 'Waiting for budget confirmation from Maintenance Planning; the capital spares budget has not been released yet.' } },
  { ref: '10046018/10', step: { do: 'hold', reason: 'Plant shutdown deferred to next month; requisitioner asked to hold until the new date is confirmed.' } },
  { ref: '10046012/10', step: { do: 'hold', reason: 'Requisitioner is reviewing an alternative LED supplier; hold until the specification is re-confirmed.' } },
  // Clarification threads with the requisitioner.
  { ref: '10046016/10', step: { do: 'clarify', thread: [['buyer', 'Please confirm the machine serial number and the harness variant (with or without the turbo sensor). The part number on the PR matches two variants.']] } },
  { ref: '10046022/10', step: { do: 'clarify', then: 'confirm', thread: [
    ['buyer', 'ENG-3008 starter motor: the PR does not say whether the 24 V unit is for the standard or the high-altitude HD785 variant. Please confirm.'],
    ['req', 'Standard variant, serial HD785-A10442, Dhanbad mine. No high-altitude kit fitted.'],
  ] } },
  { ref: '10046015/10', step: { do: 'clarify', thread: [
    ['buyer', 'Quantity of 112 is about three times the last twelve months of usage at Nagpur. Please confirm the quantity.'],
    ['req', 'The quantity is for the annual shutdown overhaul of five machines; the planner will attach the BOM.'],
    ['buyer', 'Please attach the BOM or the shutdown plan so I can justify the quantity before floating the RFQ.'],
  ] } },
  // Closed by procurement.
  { ref: '10046027/10', step: { do: 'close', reason: 'Duplicate of PR line 10046011/20 raised by the same site; one requisition is enough.' } },
  { ref: '10046030/10', step: { do: 'close', reason: 'Requirement met by a stock transfer from Nagpur stores.' } },
  // Confirmed RFQ-type routes (RFQ, Urgent/BD, Class 1, Service, Capex): the RFQ seed floats most of these.
  ...confirm(
    '10045507/10', '10045508/10', '10045509/10', '10045509/20', '10045511/10', '10045511/20', '10046004/20', '10046006/10', '10046006/20', '10046014/10', '10046019/10', '10046022/20', '10046025/10', '10046025/20',
    '10046003/10', '10046003/20', '10046007/20', '10046011/10', '10046011/20', '10046014/20', '10046016/20', '10046019/20', '10046024/20', '10046026/10', '10046026/20',
  ),
];

function userActor(userId: number | null, role: 'BUY' | 'REQ'): Actor | null {
  const email = userId ? get<{ email: string }>('SELECT email FROM users WHERE id = ?', userId)?.email : null;
  return email ? actorFor(email.split('@')[0], role) : null;
}

export function seedExtra() {
  const warn = (m: string) => console.warn(`pr seed_extra: ${m}`);
  for (const item of PLAN) {
    let id: number;
    try { id = PRL(item.ref); } catch { warn(`PR line ${item.ref} missing`); continue; }
    const l0 = S.getLine(id)!;
    const buyer = userActor(l0.buyer_id, 'BUY');
    if (l0.status !== 'Assigned' || !buyer || !l0.assigned_at) { warn(`${item.ref} is ${l0.status}; skipped`); continue; }
    const age = (Date.now() - Date.parse(l0.assigned_at)) / 86400000;
    // The buyer picks a line up soon after it is assigned (12% into its age), unless the plan says otherwise.
    const when = Math.min(item.ago ?? Math.max(0.02, age * 0.88), age * 0.97);
    try {
      tx(() => {
      S.runChecks(buyer, id);
      const s = item.step;
      let approvalId: number | null = null;
      if (s.do === 'confirm') S.decideRoute(buyer, id, { route: S.getLine(id)!.route_proposed as S.RouteName, acknowledgeStale: true });
      else if (s.do === 'override') S.decideRoute(buyer, id, { route: s.route, reason: s.reason, acknowledgeStale: true });
      else if (s.do === 'hold') S.hold(buyer, id, s.reason);
      else if (s.do === 'close') S.closeLine(buyer, id, s.reason);
      else {
        const req = userActor(l0.requisitioner_id, 'REQ');
        if (!req) throw new Error('requisitioner not found');
        let t = Date.now() - when * 86400000;
        for (const [who, body] of s.thread) {
          S.clarify(who === 'buyer' ? buyer : req, id, body);
          t = Math.min(t + (6 + (body.length % 19)) * 3600000, Date.now() - 20 * 60000);
          const cid = scalar<number>("SELECT MAX(id) FROM comments WHERE object_type = 'pr_line' AND object_id = ?", id)!;
          run('UPDATE comments SET created_at = ? WHERE id = ?', new Date(t).toISOString(), cid);
        }
        if (s.then === 'confirm') S.decideRoute(buyer, id, { route: S.getLine(id)!.route_proposed as S.RouteName, acknowledgeStale: true });
      }
      // Re-date the domain rows to when the buyer worked on the line.
      const t = ago(when);
      run('UPDATE route_decisions SET decided_at = ? WHERE pr_line_id = ?', t, id);
      run("UPDATE pr_lines SET checks_at = ?, checks_json = json_set(checks_json, '$.ran_at', ?) WHERE id = ?", ago(when + 0.02), ago(when + 0.02), id);
      if (s.do === 'close') run('UPDATE pr_lines SET closed_at = ? WHERE id = ?', t, id);
      approvalId = scalar<number>('SELECT approval_id FROM route_decisions WHERE pr_line_id = ? AND approval_id IS NOT NULL ORDER BY id DESC LIMIT 1', id) ?? null;
      if (approvalId) ageApproval(approvalId, when);
      });
    } catch (e) { warn(`${item.ref} skipped: ${(e as Error).message}`); }
  }
}
