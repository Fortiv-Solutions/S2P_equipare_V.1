/** Audit history for a record (GOV-C01) — who, role, when, what, before/after, reason. */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Empty, LoadingBlock, ErrorState } from './ui';
import { useAuth } from '@/lib/auth';

interface Ev { id: number; ts: string; actor_name: string; role: string; action: string; before: any; after: any; reason: string | null; channel: string | null }

const tone = (a: string) => (/reject|fail|denied|lock|cancel|discard/.test(a) ? 'bad' : /approve|success|confirmed|paid|matched/.test(a) ? 'ok' : /override|exception|escalat|hold/.test(a) ? 'warn' : /approval|decision/.test(a) ? 'decision' : undefined);
const label = (a: string) => a.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function Changes({ before, after }: { before: any; after: any }) {
  if (!after && !before) return null;
  const keys = [...new Set([...Object.keys(after ?? {}), ...Object.keys(before ?? {})])].slice(0, 8);
  if (!keys.length) return null;
  const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <div className="small" style={{ marginTop: 4, display: 'grid', gap: 2 }}>
      {keys.map((k) => (
        <div key={k} style={{ overflowWrap: 'anywhere' }}>
          <span className="subtle">{k.replace(/_/g, ' ')}:</span>{' '}
          {before && k in before ? <><s className="subtle">{show(before[k])}</s> → </> : null}
          <span>{show(after?.[k])}</span>
        </div>
      ))}
    </div>
  );
}

export function AuditTrail({ objectType, objectId }: { objectType: string; objectId: number | string }) {
  const { can } = useAuth();
  const q = useQuery<Ev[]>({ queryKey: ['audit', objectType, objectId], queryFn: () => api.get('/audit', { object_type: objectType, object_id: objectId }), enabled: can('audit.view') });
  if (!can('audit.view')) return <Empty title="Audit history is not available for your role" />;
  if (q.isLoading) return <LoadingBlock rows={4} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data?.length) return <Empty title="No audit events yet" />;
  return (
    <ol className="timeline">
      {q.data.map((e) => (
        <li key={e.id}>
          <span className="timeline__dot" data-tone={tone(e.action)} aria-hidden />
          <div className="timeline__title">{label(e.action)}</div>
          <div className="timeline__meta">{e.actor_name} · {e.role} · {fmtDateTime(e.ts)}{e.channel ? ` · ${e.channel}` : ''}</div>
          {e.reason && <div className="timeline__body">Reason: {e.reason}</div>}
          <Changes before={e.before} after={e.after} />
        </li>
      ))}
    </ol>
  );
}
