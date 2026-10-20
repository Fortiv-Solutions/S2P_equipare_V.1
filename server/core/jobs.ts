import { registerJob } from './scheduler.ts';
import { runAllInbound, retryOutbound } from './sap.ts';
import { escalateApprovals } from './approvals.ts';
import { cfg } from './config.ts';

export function registerCoreJobs() {
  registerJob({
    name: 'sap.inbound',
    label: 'Scheduled SAP inbound sync (simulator)',
    everyMinutes: cfg<number>('sap.auto_sync_minutes'),
    run: () => runAllInbound('scheduled').map((r) => `${r.docType}:${r.status}(${r.upserted})`).join(' '),
  });
  registerJob({ name: 'sap.retry', label: 'Retry queued SAP writes', everyMinutes: 1, run: retryOutbound });
  registerJob({ name: 'approvals.escalate', label: 'Approval reminders and escalations', everyMinutes: 15, run: escalateApprovals });
}
