/** Navigation per role (PRD 10.1). Items show only when the role holds one of the permissions. */
import type { LucideIcon } from 'lucide-react';
import {
  Home, ClipboardList, UserRound, Send, Scale, Stamp, FileSignature, Package, Truck, OctagonAlert, Receipt, Wallet,
  Building2, LifeBuoy, BarChart3, ShieldAlert, Cable, FlaskConical, Settings, History, Warehouse, FileText, UserCog, Bell,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  perms?: string[];
  count?: string; // key in /api/nav-counts
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
      { to: '/integration', label: 'SAP integration', icon: Cable, perms: ['sap.monitor'], count: 'integration', mobile: true },
      { to: '/sap-simulator', label: 'SAP simulator', icon: FlaskConical, perms: ['sapsim.all', 'sapsim.po', 'sapsim.grn', 'sapsim.fin'] },
      { to: '/admin', label: 'Administration', icon: Settings, perms: ['adm.users', 'adm.config'], mobile: true },
      { to: '/admin/config', label: 'Business rules', icon: UserCog, perms: ['adm.config', 'config.approve_tolerance'], unlessMerged: true },
      { to: '/audit', label: 'Audit log', icon: History, perms: ['audit.view'] },
    ],
  },
];

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
  const groups = isVendor ? (vendorActive ? VENDOR_NAV : VENDOR_ONBOARDING_NAV) : INTERNAL_NAV;
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !(merged && i.unlessMerged)).filter((i) => !i.perms || (i.perms.length === 0 ? !isVendor : can(...i.perms))) }))
    .filter((g) => g.items.length);
}
