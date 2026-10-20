/**
 * Role-based permissions (PRD Sec 6.2). Server-side checks are the control (FR-PLT-03);
 * the web app only mirrors this list to hide actions a role cannot take.
 */
export const ROLES = {
  REQ: 'Requisitioner',
  BUY: 'Procurement Buyer',
  APR: 'Procurement Manager / Approver',
  VEN: 'Vendor',
  STO: 'Stores / Warehouse',
  FIN: 'Finance / Accounts',
  SAP: 'SAP / IT Team',
  MGT: 'Management',
  ADM: 'System Administrator',
} as const;
export type Role = keyof typeof ROLES;
export const isRole = (r: string): r is Role => r in ROLES;

export type Perm =
  // PR workbench
  | 'pr.view_own' | 'pr.view' | 'pr.work' | 'pr.assign' | 'pr.clarify'
  // RFQ & quotation
  | 'rfq.view' | 'rfq.manage' | 'rfq.vendor' | 'qtn.submit' | 'qtn.view'
  // comparison & approval
  | 'cmp.view' | 'cmp.manage' | 'apr.decide' | 'apr.view' | 'exc.view'
  // contracts
  | 'con.view' | 'con.manage' | 'con.vendor'
  // PO
  | 'po.view' | 'po.view_own_pr' | 'po.followup' | 'po.amend' | 'po.vendor'
  // ASN / disputes
  | 'asn.view' | 'asn.vendor' | 'asn.receive' | 'dsp.view' | 'dsp.raise' | 'dsp.manage' | 'dsp.vendor' | 'dsp.hold'
  // invoice / payment
  | 'inv.view' | 'inv.vendor' | 'inv.review' | 'inv.upload_behalf' | 'inv.comment'
  | 'pay.view' | 'pay.vendor' | 'adv.request' | 'adv.manage'
  // vendor management
  | 'vendor.view' | 'vendor.onboard' | 'vendor.review_kyc' | 'vendor.review_bank' | 'vendor.self' | 'vendor.users'
  // tickets
  | 'tkt.raise' | 'tkt.handle'
  // reports
  | 'rpt.view' | 'rpt.finance' | 'rpt.stores' | 'rpt.integration' | 'rpt.export'
  // SAP & admin
  | 'sap.monitor' | 'sap.replay' | 'sapsim.po' | 'sapsim.grn' | 'sapsim.fin' | 'sapsim.all'
  | 'adm.users' | 'adm.config' | 'adm.masters' | 'audit.view' | 'audit.view_all' | 'config.approve_tolerance';

const P: Record<Role, Perm[]> = {
  REQ: ['pr.view_own', 'pr.clarify', 'po.view_own_pr', 'asn.view', 'dsp.view', 'rpt.view'],
  BUY: [
    'pr.view', 'pr.work', 'pr.assign', 'pr.clarify',
    'rfq.view', 'rfq.manage', 'qtn.view', 'cmp.view', 'cmp.manage', 'apr.view',
    'con.view', 'con.manage', 'po.view', 'po.followup', 'po.amend',
    'asn.view', 'dsp.view', 'dsp.raise', 'dsp.manage', 'inv.view', 'inv.comment', 'pay.view', 'adv.request',
    'vendor.view', 'vendor.onboard', 'tkt.handle', 'rpt.view', 'rpt.export', 'sapsim.po', 'audit.view',
  ],
  APR: [
    'pr.view', 'pr.assign', 'pr.clarify', 'rfq.view', 'qtn.view', 'cmp.view', 'apr.decide', 'apr.view', 'exc.view',
    'con.view', 'con.manage', 'po.view', 'asn.view', 'dsp.view', 'dsp.manage', 'inv.view', 'pay.view',
    'vendor.view', 'vendor.onboard', 'vendor.review_kyc', 'tkt.handle', 'rpt.view', 'rpt.export', 'audit.view',
    'config.approve_tolerance',
  ],
  VEN: [
    'rfq.vendor', 'qtn.submit', 'con.vendor', 'po.vendor', 'asn.vendor', 'dsp.vendor', 'inv.vendor', 'pay.vendor',
    'vendor.self', 'vendor.users', 'tkt.raise',
  ],
  STO: ['po.view', 'asn.view', 'asn.receive', 'dsp.view', 'dsp.raise', 'pr.view', 'rpt.view', 'rpt.stores', 'sapsim.grn', 'tkt.handle'],
  FIN: [
    'pr.view', 'cmp.view', 'apr.decide', 'apr.view', 'con.view', 'po.view', 'asn.view', 'dsp.view', 'dsp.hold', 'dsp.raise',
    'inv.view', 'inv.review', 'inv.upload_behalf', 'inv.comment', 'pay.view', 'adv.manage',
    'vendor.view', 'vendor.review_bank', 'vendor.review_kyc', 'tkt.handle', 'rpt.view', 'rpt.finance', 'rpt.export',
    'sapsim.fin', 'audit.view', 'config.approve_tolerance',
  ],
  SAP: ['sap.monitor', 'sap.replay', 'sapsim.all', 'sapsim.po', 'sapsim.grn', 'sapsim.fin', 'rpt.integration', 'audit.view', 'tkt.handle'],
  MGT: [
    'pr.view', 'rfq.view', 'qtn.view', 'cmp.view', 'apr.view', 'apr.decide', 'exc.view', 'con.view', 'po.view', 'asn.view', 'dsp.view',
    'inv.view', 'pay.view', 'vendor.view', 'rpt.view', 'rpt.finance', 'rpt.stores', 'rpt.export', 'audit.view', 'audit.view_all',
  ],
  ADM: ['adm.users', 'adm.config', 'adm.masters', 'audit.view', 'audit.view_all', 'sap.monitor', 'vendor.view', 'tkt.handle', 'rpt.integration'],
};

export function permsFor(role: Role): Set<Perm> {
  return new Set(P[role] ?? []);
}

export const ROLE_PERMISSIONS = P;

/** Internal roles that may see internal remarks; vendors never do (GOV-C08). */
export const isInternal = (role: Role) => role !== 'VEN';

/** Every internal role, held together by the single Administrator account (single-user mode). */
export const MERGED_ROLES: Role[] = ['ADM', 'APR', 'BUY', 'REQ', 'STO', 'FIN', 'SAP', 'MGT'];
/** Roles that sit on approval-matrix steps. */
export const APPROVER_STEP_ROLES: Role[] = ['APR', 'FIN', 'MGT'];

/** Union of every internal role's permissions — the vendor portal is never part of it. */
export function permsForMerged(): Set<Perm> {
  const out = new Set<Perm>();
  for (const r of MERGED_ROLES) for (const p of P[r]) out.add(p);
  return out;
}
