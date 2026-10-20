import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs, Callout, Ref } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export interface SyncOutcome { flow: string; status: string; read: number; upserted: number; errors: number; synced: boolean; message: string; error_id: number | null }

/** Sub-navigation shared by the integration screens (SCR-SAP-01..03, runbook). */
export function IntegrationNav({ counts }: { counts?: { errors?: number } }) {
  const loc = useLocation();
  const nav = useNavigate();
  const items = [
    { id: '/integration', label: 'Monitor' },
    { id: '/integration/errors', label: 'Error queue', count: counts?.errors },
    { id: '/integration/reconciliation', label: 'Reconciliation' },
    { id: '/integration/runbook', label: 'Recovery runbook' },
  ];
  const current = items.find((i) => i.id === loc.pathname)?.id ?? '/integration';
  return <Tabs value={current} onChange={(v) => nav(v)} tabs={items} />;
}

/** Shows the real result of the inbound sync that followed a simulator action. */
export function SyncResult({ sync, children }: { sync: SyncOutcome | null | undefined; children?: ReactNode }) {
  const { can } = useAuth();
  if (!sync) return null;
  return (
    <Callout tone={sync.synced ? 'ok' : 'warn'} title={sync.synced ? `Saved in SAP simulator and synced (${sync.flow})` : `Saved in SAP simulator — platform not updated yet (${sync.flow})`}>
      {children}
      <div>{sync.message}{sync.error_id ? (can('sap.monitor') ? <> <Ref to={`/integration/errors?focus=${sync.error_id}`}>Open the error</Ref></> : ' SAP/IT sees it in the integration error queue.') : null}</div>
    </Callout>
  );
}

export const prettyJson = (v: unknown) => JSON.stringify(v, null, 2);
