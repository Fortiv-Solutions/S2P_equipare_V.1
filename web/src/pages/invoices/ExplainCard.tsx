import { useQuery } from '@tanstack/react-query';
import { Lightbulb } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Callout, Card, ErrorState, LoadingBlock } from '@/components/ui';
import { SourceTag } from '@/components/insights';

interface Item {
  id: number; rule: string; reason: string; severity: string; owner: string; what: string; steps: string[]; next: string; waits: boolean;
  message: string; expected: string | null; actual: string | null; tolerance: string | null; age_days: number; vendor_message: string;
}
interface Explanation {
  headline: string; summary: string; source: 'rules' | 'model'; model?: string; recommended: { next: string; step: string } | null; items: Item[];
  ai: { mode: string; note: string };
}

const NEXT_LABEL: Record<string, string> = { wait: 'Wait', reject: 'Reject to the vendor', correct: 'Correct a field', resolve: 'Resolve', assign: 'Hand to the owner', approve: 'Approve with a reason' };
const SEV_TONE = { high: 'bad', medium: 'warn', low: 'info' } as const;

/** Plain-language reading of the match findings: what each means, who owns it, what to do first. The findings themselves come from the match engine. */
export function ExplainCard({ invoiceId }: { invoiceId: number }) {
  const q = useQuery<Explanation>({ queryKey: ['insights', 'invoice-explain', invoiceId], queryFn: () => api.get(`/insights/invoices/${invoiceId}/explain`) });
  return (
    <Card title={<div className="row-wrap"><h2>What is wrong, and what to do</h2>{q.data && <SourceTag source={q.data.source} model={q.data.model} />}</div>}>
      {q.isLoading ? <LoadingBlock rows={3} /> : q.error ? <ErrorState error={q.error} retry={q.refetch} /> : q.data && (
        <div className="stack-sm">
          <div><strong>{q.data.headline}</strong></div>
          <p style={{ margin: 0 }}>{q.data.summary}</p>
          {q.data.recommended && (
            <Callout tone="info" icon={<Lightbulb aria-hidden />} title={<>Suggested first step: {NEXT_LABEL[q.data.recommended.next] ?? q.data.recommended.next}</>}>{q.data.recommended.step}</Callout>
          )}
          <div className="stack-sm" style={{ marginTop: 4 }}>
            {q.data.items.map((i) => (
              <details key={i.id} className="explain" open={q.data!.items.length === 1}>
                <summary>
                  <span className="grow"><strong>{i.reason}</strong><span className="small muted"> · owner {i.owner}{i.age_days ? ` · open ${i.age_days} day${i.age_days === 1 ? '' : 's'}` : ''}</span></span>
                  <Badge tone={SEV_TONE[i.severity as keyof typeof SEV_TONE] ?? 'neutral'}>{i.waits ? 'Waiting' : i.severity}</Badge>
                </summary>
                <div className="stack-sm" style={{ padding: '8px 2px 4px' }}>
                  <div>{i.what}</div>
                  <div className="small muted">{i.message}</div>
                  {(i.expected || i.actual) && <div className="small"><span className="subtle">Expected</span> <strong>{i.expected ?? '—'}</strong> <span className="subtle">· found</span> <strong>{i.actual ?? '—'}</strong>{i.tolerance ? <span className="subtle"> · tolerance {i.tolerance}</span> : null}</div>}
                  <ol className="explain__steps">{i.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                  <div className="small subtle">If you reject the invoice, the vendor is told: “{i.vendor_message}”</div>
                </div>
              </details>
            ))}
          </div>
          <p className="small muted" style={{ margin: 0 }}>The findings come from the 3-way match rules and the tolerances finance approved. This card explains them. It does not approve, reject or post anything.</p>
        </div>
      )}
    </Card>
  );
}
