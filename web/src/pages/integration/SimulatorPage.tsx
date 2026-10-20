import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Callout, PageHeader, SimBadge, Tabs } from '@/components/ui';
import { useAuth, useMeta } from '@/lib/auth';
import { PoTab, GrnTab } from './sim/SimPo';
import { InvoiceTab, AdvanceTab } from './sim/SimFin';
import { PrTab, VendorTab, OaTab, StockTab, OutageTab } from './sim/SimMisc';

type Tab = 'pr' | 'po' | 'grn' | 'invoice' | 'advance' | 'vendor' | 'oa' | 'stock' | 'outage';
/** sapsim.po buyers · sapsim.grn stores · sapsim.fin finance · sapsim.all SAP/IT (server enforces the same). */
const TABS: { id: Tab; label: string; perms: string[] }[] = [
  { id: 'pr', label: 'Purchase requisitions', perms: ['sapsim.all'] },
  { id: 'po', label: 'Purchase orders', perms: ['sapsim.po', 'sapsim.all'] },
  { id: 'grn', label: 'GRN / SES', perms: ['sapsim.grn', 'sapsim.all'] },
  { id: 'invoice', label: 'Invoices', perms: ['sapsim.fin', 'sapsim.all'] },
  { id: 'advance', label: 'Advances', perms: ['sapsim.fin', 'sapsim.all'] },
  { id: 'vendor', label: 'Vendors', perms: ['sapsim.all'] },
  { id: 'oa', label: 'Outline agreements', perms: ['sapsim.po', 'sapsim.all'] },
  { id: 'stock', label: 'Stock', perms: ['sapsim.grn', 'sapsim.all'] },
  { id: 'outage', label: 'Outage & failures', perms: ['sapsim.all'] },
];
const ACTION_TAB: Record<string, Tab> = { po: 'po', grn: 'grn', oa: 'oa', vendor: 'vendor', invoice: 'invoice', advance: 'advance', pr: 'pr', stock: 'stock' };

export default function SimulatorPage() {
  const { can } = useAuth();
  const meta = useMeta();
  const [sp, setSp] = useSearchParams();
  const tabs = useMemo(() => TABS.filter((t) => can(...t.perms)), [can]);
  const requested = (sp.get('tab') as Tab) ?? ACTION_TAB[sp.get('action') ?? ''];
  const tab = tabs.find((t) => t.id === requested)?.id ?? tabs[0]?.id;
  const num = (k: string) => (sp.get(k) ? Number(sp.get(k)) : null);
  return (
    <>
      <PageHeader title="SAP simulator console" screen="SCR-SAP-04" eyebrow="Module 12"
        sub="Stands in for SAP in this MVP. Every action here is performed in the simulated SAP system, audited, and then synced into the platform through the normal inbound flow."
        badges={<SimBadge title="No live SAP system is connected (DEC-17).">SAP simulator</SimBadge>} />
      <div className="sim-panel" style={{ marginBottom: 16 }}>
        <span className="small"><SimBadge>SAP simulator</SimBadge> Nothing on this page touches a real SAP system. Your actions are limited by your role: buyers create POs and outline agreements, stores post receipts and stock, finance handles invoices and advances, SAP/IT can do everything.</span>
      </div>
      {meta.data?.sapOffline && <div style={{ marginBottom: 16 }}><Callout tone="bad" title="SAP is offline (simulated outage)">Simulator actions are saved in SAP but the inbound syncs will fail until SAP is brought back online (Outage & failures tab).</Callout></div>}
      {!tab ? <Callout tone="warn" title="Your role has no SAP simulator actions">Ask your administrator if you need to act in the simulator.</Callout> : (
        <>
          <Tabs<Tab> value={tab} onChange={(t) => { const n = new URLSearchParams(); n.set('tab', t); setSp(n, { replace: true }); }} tabs={tabs.map((t) => ({ id: t.id, label: t.label }))} />
          <div style={{ marginTop: 16 }}>
            {tab === 'pr' && <PrTab />}
            {tab === 'po' && <PoTab preComparison={num('comparison')} prePrLine={num('pr_line')} />}
            {tab === 'grn' && <GrnTab prePo={sp.get('po')} />}
            {tab === 'invoice' && <InvoiceTab pre={sp.get('inv')} />}
            {tab === 'advance' && <AdvanceTab pre={sp.get('adv')} />}
            {tab === 'vendor' && <VendorTab pre={num('vendor')} />}
            {tab === 'oa' && <OaTab pre={num('contract')} />}
            {tab === 'stock' && <StockTab />}
            {tab === 'outage' && <OutageTab />}
          </div>
        </>
      )}
    </>
  );
}
