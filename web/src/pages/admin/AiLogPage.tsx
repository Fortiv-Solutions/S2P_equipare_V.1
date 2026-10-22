import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fmtDateTime, fmtPct } from '@/lib/format';
import { Badge, Callout, Card, KV, Kpi, Loader, PageHeader, Status } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { SourceTag, type AiInfo } from '@/components/insights';

interface Item { id: number; kind: string; object_type: string | null; object_id: number | null; object_ref: string | null; source: string; summary: string; score: number | null; decision: string; outcome: string | null; decided_by_name: string; decided_at: string }
interface Data { items: Item[]; stats: { total: number; accepted: number; acceptance_rate: number | null; by_kind: { kind: string; decision: string; n: number }[] }; ai: AiInfo }

const KIND: Record<string, string> = { po_reminder: 'PO reminder', po_escalation: 'PO escalation', vendor_reply: 'Vendor reply read', invoice_explanation: 'Invoice explanation', ask: 'Question' };
const LINK: Record<string, string> = { po: '/pos', invoice: '/invoices' };

/** Every suggestion a person accepted, edited or dismissed, next to what they decided. */
export default function AiLogPage() {
  const q = useQuery<Data>({ queryKey: ['insights', 'log'], queryFn: () => api.get('/insights/log') });
  const cols: Column<Item>[] = [
    { key: 'decided_at', header: 'When', render: (r) => <span className="nowrap">{fmtDateTime(r.decided_at)}</span> },
    { key: 'kind', header: 'Suggestion', render: (r) => KIND[r.kind] ?? r.kind, value: (r) => KIND[r.kind] ?? r.kind },
    { key: 'object_ref', header: 'Record', render: (r) => (r.object_type && r.object_id ? <Link to={`${LINK[r.object_type] ?? ''}/${r.object_id}`} className="mono">{r.object_ref ?? r.object_id}</Link> : '—') },
    { key: 'summary', header: 'What was suggested', render: (r) => <span style={{ minWidth: 220, display: 'inline-block' }}>{r.summary}</span> },
    { key: 'score', header: 'Score', align: 'right', render: (r) => r.score ?? '—' },
    { key: 'source', header: 'Source', render: (r) => <SourceTag source={r.source === 'model' ? 'model' : 'rules'} />, value: (r) => r.source },
    { key: 'decision', header: 'Decision', render: (r) => <Status value={r.decision} tone={r.decision === 'Dismissed' ? 'neutral' : r.decision === 'Edited' ? 'warn' : 'ok'} /> },
    { key: 'outcome', header: 'Outcome', render: (r) => r.outcome ?? '—' },
    { key: 'decided_by_name', header: 'By' },
  ];
  return (
    <>
      <PageHeader eyebrow={<><Link to="/admin">Administration</Link><span>/</span><span>AI assistance</span></>} title="AI assistance" sub="What the assistance layer suggests, what it is built on, and what people did with it." />
      <Loader q={q} rows={6}>{(d) => (
        <div className="stack">
          <Callout tone={d.ai.active ? 'info' : 'ok'} title={d.ai.active ? `An AI model words summaries (${d.ai.model})` : 'Rules only. No AI model is connected.'}>{d.ai.note}</Callout>
          <div className="grid-3">
            <Kpi label="Suggestions acted on" value={d.stats.total} meta="Accepted, edited or dismissed by a person" />
            <Kpi label="Accepted or edited" value={d.stats.acceptance_rate == null ? '—' : fmtPct(d.stats.acceptance_rate, 0)} meta={`${d.stats.accepted} of ${d.stats.total}`} />
            <Kpi label="Mode" value={d.ai.mode === 'rules' ? 'Rules' : 'Rules + model'} meta="Facts and scores are always rules" />
          </div>
          <Card title="What the assistance layer does">
            <KV items={[
              ['Delivery risk', 'A score from named factors: days late, no dispatch, no acknowledgement, moved commitments, reminders without a reply, vendor delivery record. Weights are a proposed default.'],
              ['Invoice explanation', 'Turns each 3-way match finding into what it means, who owns it and what to do. The findings and tolerances stay with the match engine.'],
              ['Vendor reply reading', 'Finds explicit dates and a delay reason in pasted text. A person confirms before anything is saved.'],
              ['Ask the data', 'Keyword and filter rules over read-only queries. It says how it understood the question. It is not a chatbot.'],
              ['AI model (optional)', <>Off by default. When switched on in <Link to="/admin/config">business configuration</Link> and a key is set on the server, a model rewords one summary paragraph from computed facts. Numbers it adds that are not in the facts are rejected. Nothing else is sent.</>],
              ['What it never does', 'It never posts to SAP, approves, rejects, pays, or changes a match result or a tolerance.'],
            ]} />
          </Card>
          <Card title="Log" flush>
            <DataTable id="ai-log" rows={d.items} columns={cols} rowKey={(r) => r.id} searchable savedViews={false} pageSize={25} exportName="ai-assistance-log" />
          </Card>
          <p className="small muted"><Badge tone="neutral" plain>Audit</Badge> Each decision is also written to the audit log as <span className="mono">ai.suggestion_*</span>.</p>
        </div>
      )}</Loader>
    </>
  );
}
