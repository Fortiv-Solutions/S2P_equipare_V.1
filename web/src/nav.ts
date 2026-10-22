/** Navigation per role (PRD 10.1). Items show only when the role holds one of the permissions. */
import type { LucideIcon } from 'lucide-react';
import {
  Home, ClipboardList, UserRound, Send, Scale, Stamp, FileSignature, Package, Truck, OctagonAlert, Receipt, Wallet,
  Building2, LifeBuoy, BarChart3, ShieldAlert, Cable, FlaskConical, Settings, History, Warehouse, FileText, UserCog, Bell, Compass,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  perms?: string[];
  count?: string; // key in /api/nav-counts
  /** Sum of several /api/nav-counts keys (workspace entries). */
  counts?: string[];
  mobile?: boolean; // candidate for the phone bottom bar
  /** Another entry already covers this for the merged Administrator (shown only to single-purpose roles). */
  unlessMerged?: boolean;
}
export interface NavGroup { label: string; items: NavItem[] }

export const INTERNAL_NAV: NavGroup[] = [
  {
    label: 'Work',
    items: [
      { to: '/', label: 'Home', icon: Home, mobile: true },
      { to: '/my-requirements', label: 'My requirements', icon: UserRound, perms: ['pr.view_own'], mobile: true, unlessMerged: true },
      { to: '/pr', label: 'PR workbench', icon: ClipboardList, perms: ['pr.work', 'pr.assign'], count: 'pr', mobile: true },
      { to: '/rfqs', label: 'RFQs', icon: Send, perms: ['rfq.view'], count: 'rfq' },
      { to: '/comparisons', label: 'Comparisons', icon: Scale, perms: ['cmp.view'] },
      { to: '/approvals', label: 'Approvals', icon: Stamp, perms: ['apr.decide', 'apr.view'], count: 'approvals', mobile: true },
      { to: '/contracts', label: 'Contracts', icon: FileSignature, perms: ['con.view'], count: 'contracts' },
      { to: '/pos', label: 'Purchase orders', icon: Package, perms: ['po.view'], count: 'po', mobile: true },
      { to: '/receipts', label: 'Expected receipts', icon: Warehouse, perms: ['asn.receive'], mobile: true, unlessMerged: true },
      { to: '/asns', label: 'ASN & dispatch', icon: Truck, perms: ['asn.view'] },
      { to: '/disputes', label: 'Disputes', icon: OctagonAlert, perms: ['dsp.view'], count: 'disputes' },
      { to: '/invoices', label: 'Invoices', icon: Receipt, perms: ['inv.view'], count: 'invoices', mobile: true },
      { to: '/payments', label: 'Payments & advances', icon: Wallet, perms: ['pay.view'] },
      { to: '/vendors', label: 'Vendors', icon: Building2, perms: ['vendor.view'], count: 'vendors' },
      { to: '/tickets', label: 'Vendor tickets', icon: LifeBuoy, perms: ['tkt.handle'], count: 'tickets' },
    ],
  },
  {
    label: 'Insight',
    items: [
      { to: '/reports', label: 'Reports & KPIs', icon: BarChart3, perms: ['rpt.view', 'rpt.integration'] },
      { to: '/exceptions', label: 'Exception register', icon: ShieldAlert, perms: ['exc.view'], unlessMerged: true },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/integration', label: 'Integration', icon: Cable, perms: ['sap.monitor'], count: 'integration', mobile: true },
      { to: '/sap-simulator', label: 'Simulator', icon: FlaskConical, perms: ['sapsim.all', 'sapsim.po', 'sapsim.grn', 'sapsim.fin'] },
      { to: '/admin', label: 'Administration', icon: Settings, perms: ['adm.users', 'adm.config'], mobile: true },
      { to: '/admin/config', label: 'Business rules', icon: UserCog, perms: ['adm.config', 'config.approve_tolerance'], unlessMerged: true },
      { to: '/audit', label: 'Audit log', icon: History, perms: ['audit.view'] },
    ],
  },
];

/**
 * The Administrator holds every module, so the sidebar shows three workspaces instead of fifteen modules.
 * Each workspace opens on an overview and keeps the module screens one click away in a tab strip (see WORKSPACES).
 * Role-based accounts (multi-user mode) keep INTERNAL_NAV.
 */
export const MERGED_NAV: NavGroup[] = [
  {
    label: 'Work',
    items: [
      { to: '/', label: 'Home', icon: Home, mobile: true },
      { to: '/sourcing', label: 'Sourcing', icon: Compass, perms: ['pr.work', 'pr.assign', 'rfq.view', 'cmp.view', 'apr.view', 'con.view', 'vendor.view'], counts: ['pr', 'approvals', 'rfq', 'contracts', 'vendors'], mobile: true },
      { to: '/delivery', label: 'Delivery', icon: Truck, perms: ['po.view', 'asn.view', 'dsp.view', 'tkt.handle'], counts: ['po', 'disputes', 'tickets'], mobile: true },
      { to: '/finance', label: 'Finance', icon: Receipt, perms: ['inv.view', 'pay.view'], counts: ['invoices'], mobile: true },
    ],
  },
  { label: 'Insight', items: [{ to: '/reports', label: 'Reports & KPIs', icon: BarChart3, perms: ['rpt.view', 'rpt.integration'] }] },
  {
    label: 'System',
    items: [
      { to: '/integration', label: 'Integration', icon: Cable, perms: ['sap.monitor'], count: 'integration' },
      { to: '/sap-simulator', label: 'Simulator', icon: FlaskConical, perms: ['sapsim.all', 'sapsim.po', 'sapsim.grn', 'sapsim.fin'] },
      { to: '/admin', label: 'Administration', icon: Settings, perms: ['adm.users', 'adm.config'] },
      { to: '/audit', label: 'Audit log', icon: History, perms: ['audit.view'] },
    ],
  },
];

export interface WorkspaceTab { to: string; label: string; icon: LucideIcon; perms?: string[]; count?: string; match?: string[] }
export interface Workspace { key: 'sourcing' | 'delivery' | 'finance'; label: string; to: string; icon: LucideIcon; blurb: string; tabs: WorkspaceTab[] }

/** Tab strip per workspace. A path belongs to the tab with the longest matching prefix. */
export const WORKSPACES: Workspace[] = [
  {
    key: 'sourcing', label: 'Sourcing', to: '/sourcing', icon: Compass, blurb: 'From an open requirement to an approved award: PRs, RFQs, quotes, comparisons, approvals, contracts and vendors.',
    tabs: [
      { to: '/sourcing', label: 'Overview', icon: Compass },
      { to: '/pr', label: 'PR workbench', icon: ClipboardList, perms: ['pr.work', 'pr.assign'], count: 'pr', match: ['/pr', '/my-requirements'] },
      { to: '/rfqs', label: 'RFQs', icon: Send, perms: ['rfq.view'], count: 'rfq' },
      { to: '/comparisons', label: 'Comparisons', icon: Scale, perms: ['cmp.view'] },
      { to: '/approvals', label: 'Approvals', icon: Stamp, perms: ['apr.decide', 'apr.view'], count: 'approvals', match: ['/approvals', '/exceptions'] },
      { to: '/contracts', label: 'Contracts', icon: FileSignature, perms: ['con.view'], count: 'contracts' },
      { to: '/vendors', label: 'Vendors', icon: Building2, perms: ['vendor.view'], count: 'vendors' },
    ],
  },
  {
    key: 'delivery', label: 'Delivery', to: '/delivery', icon: Truck, blurb: 'From a released PO to goods received: acknowledgement, dispatch, receipts, disputes and vendor tickets.',
    tabs: [
      { to: '/delivery', label: 'Overview', icon: Truck },
      { to: '/pos', label: 'Purchase orders', icon: Package, perms: ['po.view'], count: 'po' },
      { to: '/asns', label: 'ASN & dispatch', icon: Truck, perms: ['asn.view'] },
      { to: '/receipts', label: 'Expected receipts', icon: Warehouse, perms: ['asn.receive'] },
      { to: '/disputes', label: 'Disputes', icon: OctagonAlert, perms: ['dsp.view'], count: 'disputes' },
      { to: '/tickets', label: 'Vendor tickets', icon: LifeBuoy, perms: ['tkt.handle'], count: 'tickets' },
    ],
  },
  {
    key: 'finance', label: 'Finance', to: '/finance', icon: Receipt, blurb: 'From invoice to payment: reading, 3-way match, exceptions, SAP posting status, payments and advances.',
    tabs: [
      { to: '/finance', label: 'Overview', icon: Receipt },
      { to: '/invoices', label: 'Invoices', icon: Receipt, perms: ['inv.view'], count: 'invoices' },
      { to: '/invoices/exceptions', label: 'Exception queue', icon: ShieldAlert, perms: ['inv.view'] },
      { to: '/payments', label: 'Payments & advances', icon: Wallet, perms: ['pay.view'], match: ['/payments', '/advances'] },
    ],
  },
];

const starts = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** The workspace and tab a path belongs to, or null (home, reports, system screens, vendor portal…). */
export function workspaceOf(path: string): { workspace: Workspace; tab: WorkspaceTab } | null {
  let best: { workspace: Workspace; tab: WorkspaceTab; len: number } | null = null;
  for (const w of WORKSPACES) {
    for (const t of w.tabs) {
      for (const p of t.match ?? [t.to]) {
        if (starts(path, p) && (!best || p.length > best.len)) best = { workspace: w, tab: t, len: p.length };
      }
    }
  }
  return best ? { workspace: best.workspace, tab: best.tab } : null;
}

export const VENDOR_NAV: NavGroup[] = [
  {
    label: 'Your work',
    items: [
      { to: '/vendor', label: 'Home', icon: Home, mobile: true },
      { to: '/vendor/rfqs', label: 'RFQs', icon: Send, count: 'v_rfq', mobile: true },
      { to: '/vendor/pos', label: 'Purchase orders', icon: Package, count: 'v_po', mobile: true },
      { to: '/vendor/asns', label: 'Dispatch (ASN)', icon: Truck },
      { to: '/vendor/invoices', label: 'Invoices', icon: Receipt, count: 'v_inv', mobile: true },
      { to: '/vendor/payments', label: 'Payments', icon: Wallet },
      { to: '/vendor/disputes', label: 'Disputes', icon: OctagonAlert, count: 'v_dsp' },
      { to: '/vendor/contracts', label: 'Contracts', icon: FileText },
    ],
  },
  {
    label: 'Account',
    items: [
      { to: '/vendor/profile', label: 'Profile & documents', icon: Building2 },
      { to: '/vendor/tickets', label: 'Help & tickets', icon: LifeBuoy, count: 'v_tkt' },
      { to: '/notifications', label: 'Notifications', icon: Bell },
    ],
  },
];

/** Vendors that are not Active yet (onboarding) only see onboarding, profile, help and notifications. */
const VENDOR_ONBOARDING_NAV: NavGroup[] = [
  {
    label: 'Get started',
    items: [
      { to: '/vendor', label: 'Home', icon: Home, mobile: true },
      { to: '/vendor/onboarding', label: 'Registration', icon: FileText, mobile: true },
      { to: '/vendor/profile', label: 'Profile & documents', icon: Building2, mobile: true },
      { to: '/vendor/tickets', label: 'Help & tickets', icon: LifeBuoy, mobile: true },
      { to: '/notifications', label: 'Notifications', icon: Bell },
    ],
  },
];

export function navFor(isVendor: boolean, can: (...p: string[]) => boolean, vendorActive = true, merged = false): NavGroup[] {
  const groups = isVendor ? (vendorActive ? VENDOR_NAV : VENDOR_ONBOARDING_NAV) : merged ? MERGED_NAV : INTERNAL_NAV;
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !(merged && i.unlessMerged)).filter((i) => !i.perms || (i.perms.length === 0 ? !isVendor : can(...i.perms))) }))
    .filter((g) => g.items.length);
}
