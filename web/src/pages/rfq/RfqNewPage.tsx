import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FilePlus2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtLakh, fmtNum } from '@/lib/format';
import { Badge, Button, ButtonLink, Callout, Card, Empty, Loader, PageHeader, Priority } from '@/components/ui';
import { ErrorSummary, Field, Input, Select, fieldError } from '@/components/forms';
import { fromLocalInput, toLocalInput, type Autofill, type Excluded, type SuggestedVendor } from './shared';

interface DraftLine { pr_line_id: number | null; pr_ref: string | null; material_code: string | null; description: string; qty: number; uom: string; required_date: string | null; plant: string; priority: string; category: string | null; autofill: Autofill; contract: { contract_no: string | null; contract_type: string | null; vendor: string | null } | null }
interface Preview {
  kind: 'Spot' | 'ARC'; ok: boolean; problems: { ref: string; problem: string }[]; lines: DraftLine[]; closing_default: string;
  suggestions: { vendors: SuggestedVendor[]; excluded: Excluded[] }; plants: { code: string; name: string; ship_to_address: string }[];
  opportunity: { id: number; material_code: string; description: string; uom: string; annual_qty_estimate: number; qty_basis: string; frequency: number | null; annual_value: number | null; plants: string[]; rfq_id: number | null; status: string } | null;
}

/** SCR-RFQ-01 step 1: check the basket, show auto-filled values and suggestions, create the draft. */
export default function RfqNewPage() {
  const [sp] = useSearchParams();
  const lineIds = (sp.get('lines') ?? '').split(',').map(Number).filter((n) => n > 0);
  const opportunity = Number(sp.get('opportunity')) || undefined;
  const [plant, setPlant] = useState('');
  const q = useQuery<Preview>({
    queryKey: ['rfq', 'preview', lineIds.join(','), opportunity, plant],
    queryFn: () => api.post('/rfq/preview', opportunity ? { opportunity_id: opportunity, plant: plant || undefined } : { pr_line_ids: lineIds }),
    enabled: lineIds.length > 0 || !!opportunity,
  });
  if (!lineIds.length && !opportunity) {
    return (
      <>
        <PageHeader title="New RFQ" screen="SCR-RFQ-01" eyebrow={<><Link to="/rfqs">RFQs</Link><span>/</span><span>New</span></>} />
        <Card><Empty title="Choose PR lines first" action={<ButtonLink to="/pr?view=mine&status=Route+decided" variant="primary">Open the PR workbench</ButtonLink>}>Select lines whose route is decided, then choose "Create RFQ from …".</Empty></Card>
      </>
    );
  }
  return <Loader q={q} rows={8}>{(p) => <Builder p={p} opportunity={opportunity} plant={plant} setPlant={setPlant} lineIds={lineIds} />}</Loader>;
}

function Builder({ p, opportunity, plant, setPlant, lineIds }: { p: Preview; opportunity?: number; plant: string; setPlant: (v: string) => void; lineIds: number[] }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [title, setTitle] = useState('');
  const [closing, setClosing] = useState(toLocalInput(p.closing_default));
  const [qty, setQty] = useState(String(p.opportunity?.annual_qty_estimate ?? ''));
  useEffect(() => { if (p.opportunity && !plant) setPlant(p.lines[0]?.plant ?? ''); }, [p.opportunity, plant, setPlant, p.lines]);
  const create = useAction(() => api.post<{ id: number; rfq_no: string }>('/rfq/rfqs', {
    ...(opportunity ? { opportunity_id: opportunity, plant: plant || undefined, qty: Number(qty) } : { pr_line_ids: lineIds }),
    title: title.trim() || undefined, closing_at: closing ? fromLocalInput(closing) : undefined,
  }), { success: (r) => `Draft RFQ ${r.rfq_no} created`, invalidate: [['rfq'], ['pr']], onSuccess: (r) => navigate(`/rfqs/${r.id}`), silentError: true });
  const contracts = p.lines.filter((l) => l.contract?.contract_no);
  const o = p.opportunity;
  return (
    <>
      <PageHeader
        eyebrow={<><Link to="/rfqs">RFQs</Link><span>/</span><span>New</span></>} screen="SCR-RFQ-01"
        title={o ? `Annual-rate RFQ for ${o.material_code}` : `New RFQ from ${p.lines.length} PR line${p.lines.length === 1 ? '' : 's'}`}
        sub={o ? 'Sourcing step of the ARC creation workflow (FR-CON-08): vendors quote unit rates valid for 12 months.' : 'Check the basket, then create a draft. You choose vendors, terms and attachments on the next screen.'}
        badges={o ? <Badge tone="decision">Annual rate (ARC)</Badge> : undefined}
      />
      {!p.ok && (
        <Callout tone="bad" title="These lines cannot go into one RFQ">
          <ul style={{ margin: '4px 0 8px', paddingLeft: 18 }}>{p.problems.map((x, i) => <li key={i}><span className="mono">{x.ref}</span> — {x.problem}</li>)}</ul>
          <ButtonLink to="/pr?view=mine&status=Route+decided" size="sm">Back to the PR workbench</ButtonLink>
        </Callout>
      )}
      {o?.rfq_id && <Callout tone="warn" title="This opportunity already has an RFQ"><Link to={`/rfqs/${o.rfq_id}`}>Open the existing RFQ</Link> — a second one can be created only if that one was cancelled or re-floated.</Callout>}
      {contracts.length > 0 && <Callout tone="warn" title="Valid contract found at RFQ creation (FR-CON-03)">{contracts.map((l) => `${l.pr_ref}: ${l.contract!.contract_type} ${l.contract!.contract_no} with ${l.contract!.vendor}`).join('; ')}. The route was confirmed off-contract; this is recorded on the RFQ.</Callout>}
      <div style={{ height: 12 }} />
      <div className="split">
        <div className="stack">
          <Card title="Lines and auto-filled values" actions={<span className="small muted">From SAP material and plant masters (FR-RFQ-06) — editable on the next screen</span>} flush>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Line</th><th>PR / material</th><th className="num">Qty</th><th>Required</th><th>Plant / ship-to</th><th>GST</th><th>Valuation</th><th>Transport</th></tr></thead>
                <tbody>
                  {p.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="mono">{(i + 1) * 10}</td>
                      <td style={{ minWidth: 220 }}><div style={{ fontWeight: 600 }}>{l.description}</div><div className="small subtle"><span className="mono">{l.pr_ref ?? 'No PR (annual rate)'} · {l.material_code}</span> {l.priority !== 'Normal' && <Priority value={l.priority} />}</div></td>
                      <td className="num nowrap">{fmtNum(o ? Number(qty) || l.qty : l.qty)} {l.uom}</td>
                      <td className="nowrap">{fmtDate(l.required_date)}</td>
                      <td style={{ minWidth: 200 }}><strong>{l.plant}</strong><div className="small subtle">{l.autofill.ship_to ?? <span style={{ color: 'var(--bad)' }}>No ship-to address in plant master</span>}</div></td>
                      <td>{l.autofill.gst_rate != null ? `${l.autofill.gst_rate}%` : '—'}</td>
                      <td>{l.autofill.valuation_type ?? '—'}</td>
                      <td className="small" style={{ minWidth: 160 }}>{l.autofill.transport_req ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Vendors the rules suggest" actions={<span className="small muted">FR-RFQ-02 · deterministic ranking</span>}>
            {p.suggestions.vendors.length === 0 ? <Callout tone="warn" title="No vendor is mapped to this category">You can add vendors with a justification on the next screen; fewer than the category minimum routes a limited-source exception.</Callout> : (
              <ul className="list-plain stack-sm">
                {p.suggestions.vendors.slice(0, 6).map((v) => (
                  <li key={v.vendor_id} className="row between" style={{ borderBottom: '1px solid var(--steel-100)', paddingBottom: 6 }}>
                    <span><strong>{v.name}</strong> <span className="mono small subtle">{v.sap_code}</span><div className="small muted">{v.reasons.slice(0, 3).map((r) => r.label).join(' · ')}</div></span>
                    <Badge tone="deep">{v.score} pts</Badge>
                  </li>
                ))}
              </ul>
            )}
            {p.suggestions.excluded.length > 0 && <p className="small muted" style={{ marginTop: 10 }}>Excluded: {p.suggestions.excluded.map((e) => `${e.name} (${e.reasons.join('; ')})`).join(' · ')}</p>}
          </Card>
        </div>
        <Card title="Create draft">
          <div className="stack">
            <ErrorSummary error={create.error} />
            {o && (
              <>
                <Callout tone="info">{o.description}. Bought {o.frequency ?? '—'} times, {fmtLakh(o.annual_value)} a year. Estimate basis: {o.qty_basis}.</Callout>
                <Field label="Plant / ship-to" required error={fieldError(create.error, 'plant')}><Select value={plant} onChange={(e) => setPlant(e.target.value)} options={p.plants.map((x) => ({ value: x.code, label: `${x.code} — ${x.name}` }))} /></Field>
                <Field label={`Estimated annual quantity (${o.uom})`} required hint="Indicative only — not a purchase commitment." error={fieldError(create.error, 'qty')}><Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
              </>
            )}
            <Field label="Title" hint="Leave blank to use the first line's description."><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={p.lines[0]?.description} /></Field>
            <Field label="Closing date and time" required hint="Proposed from line priority (urgent / BD close sooner). Change it later in the builder." error={fieldError(create.error, 'closing_at')}>
              <Input type="datetime-local" value={closing} onChange={(e) => setClosing(e.target.value)} />
            </Field>
            {can('rfq.manage') ? (
              <Button variant="primary" icon={<FilePlus2 />} loading={create.busy} disabled={!p.ok || !!o?.rfq_id || (!!o && !(Number(qty) > 0))} onClick={create.fire}>Create draft RFQ</Button>
            ) : <Callout tone="info">Only procurement buyers create RFQs.</Callout>}
            <p className="small muted">{o ? 'The opportunity moves to Accepted (sourcing started).' : 'The PR lines move to "RFQ in progress" and stay linked to their RFQ lines.'}</p>
          </div>
        </Card>
      </div>
    </>
  );
}
