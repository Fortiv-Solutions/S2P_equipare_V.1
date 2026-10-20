/** SCR-ADM-02 business configuration: typed editors, reason, versions, pending tolerance approvals. */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Pencil, History as HistoryIcon, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Badge, Button, Callout, Card, DecisionTag, Loader, PageHeader, Ref, Status } from '@/components/ui';
import { Checkbox, ErrorSummary, Field, Input, Textarea } from '@/components/forms';
import { Modal } from '@/components/overlay';

interface Item { key: string; label: string; group_name: string; description: string; value: unknown; version: number; requires_approval: number; decision_ref: string | null; updated_at: string; status: string }
interface Pending { id: number; key: string; value: unknown; current: unknown; reason: string; requested_at: string; requested_by_name: string; label: string; approval_id: number | null; req_no: string | null; approval_status: string | null }

const kind = (v: unknown): 'number' | 'boolean' | 'string' | 'list' | 'map' | 'json' => {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') ? 'list' : 'json';
  if (v && typeof v === 'object') return Object.values(v).every((x) => ['number', 'string', 'boolean'].includes(typeof x)) ? 'map' : 'json';
  return 'json';
};
const show = (v: unknown): string => {
  const k = kind(v);
  if (k === 'boolean') return v ? 'On' : 'Off';
  if (k === 'list') return (v as string[]).join(', ');
  if (k === 'map') { const t = Object.entries(v as object).map(([a, b]) => `${a}: ${b}`).join(' · '); return t.length > 240 ? `${t.slice(0, 240)}…` : t; }
  if (k === 'json') return JSON.stringify(v).slice(0, 120) + (JSON.stringify(v).length > 120 ? '…' : '');
  return String(v);
};

export default function ConfigPage() {
  const { can } = useAuth();
  const editable = can('adm.config');
  const q = useQuery<{ items: Item[]; pending: unknown[] }>({ queryKey: ['admin', 'config'], queryFn: () => api.get('/config') });
  const pending = useQuery<Pending[]>({ queryKey: ['admin', 'config', 'pending'], queryFn: () => api.get('/admin/config/pending') });
  const [edit, setEdit] = useState<Item | null>(null);
  const [hist, setHist] = useState<Item | null>(null);
  const [search, setSearch] = useState('');
  const groups = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of q.data?.items ?? []) {
      if (search && !`${i.label} ${i.key} ${i.description}`.toLowerCase().includes(search.toLowerCase())) continue;
      m.set(i.group_name, [...(m.get(i.group_name) ?? []), i]);
    }
    return [...m.entries()];
  }, [q.data, search]);
  return (
    <>
      <PageHeader title="Business configuration" screen="SCR-ADM-02" eyebrow={<Link to="/admin">Administration</Link>}
        sub={editable ? 'Business rules are data, not code. Every change needs a reason, creates a new version and is audited. Values tagged with a decision are proposed defaults awaiting an Equipcare decision.' : 'Read-only: you can see the active rules and their history. Changes are made by the platform administrator.'}
        actions={<Link className="btn btn--secondary" to="/admin/approval-matrix">Approval matrix</Link>} />
      {!editable && <Callout tone="info">Your role has no configuration edit permission (adm.config).</Callout>}
      {!!pending.data?.length && (
        <Card title="Changes waiting for approval">
          <ul className="list-plain stack-sm">
            {pending.data.map((p) => (
              <li key={p.id} className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span><strong>{p.label}</strong> <span className="small muted">requested by {p.requested_by_name} · {fmtDateTime(p.requested_at)}</span><div className="small">{show(p.current)} → <strong>{show(p.value)}</strong> · {p.reason}</div></span>
                <span className="row">{p.approval_id ? <Ref to={`/approvals/${p.approval_id}`}>{p.req_no}</Ref> : null}<Status value={p.approval_status ?? 'Pending'} /></span>
              </li>
            ))}
          </ul>
          <p className="small muted" style={{ marginTop: 8 }}>The active version stays in force until finance and procurement approve (GOV-C07, DEC-07).</p>
        </Card>
      )}
      <div style={{ margin: '16px 0', maxWidth: 360 }}><Input aria-label="Search settings" placeholder="Search settings…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <Loader q={q} rows={8}>{() => (
        <div className="stack">
          {groups.length === 0 && <Card><p>No setting matches “{search}”.</p></Card>}
          {groups.map(([g, items]) => (
            <Card key={g} title={g} flush>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Setting</th><th>Current value</th><th>Version</th><th /></tr></thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.key}>
                        <td style={{ maxWidth: 420 }}>
                          <div className="row-wrap"><strong>{i.label}</strong><DecisionTag id={i.decision_ref} />{i.requires_approval ? <Badge tone="decision" plain>Needs approval</Badge> : null}</div>
                          <div className="small muted">{i.description}</div><div className="small subtle mono">{i.key}</div>
                        </td>
                        <td style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{show(i.value)}</td>
                        <td className="nowrap">v{i.version}<div className="small subtle">{fmtDateTime(i.updated_at)}</div></td>
                        <td><div className="row-wrap">{editable && <Button size="sm" icon={<Pencil />} onClick={() => setEdit(i)}>Edit</Button>}<Button size="sm" variant="ghost" icon={<HistoryIcon />} onClick={() => setHist(i)}>History</Button></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}</Loader>
      {edit && <EditDialog item={edit} onClose={() => setEdit(null)} />}
      {hist && <HistoryDialog item={hist} onClose={() => setHist(null)} />}
    </>
  );
}

function ValueEditor({ item, value, onChange, error }: { item: Item; value: unknown; onChange: (v: unknown, valid: boolean) => void; error: boolean }) {
  const k = kind(item.value);
  const [text, setText] = useState(() => (k === 'json' ? JSON.stringify(item.value, null, 2) : k === 'list' ? (item.value as string[]).join('\n') : String(item.value)));
  const [rows, setRows] = useState<[string, string][]>(() => (k === 'map' ? Object.entries(item.value as object).map(([a, b]) => [a, String(b)]) : []));
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  void value; void error;
  if (k === 'boolean') return <Checkbox label={`${item.label} is on`} checked={value as boolean} onChange={(e) => onChange(e.target.checked, true)} />;
  if (k === 'number') return <Field label="Value" required><Input type="number" step="any" value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value === '' ? NaN : Number(e.target.value), e.target.value !== '' && Number.isFinite(Number(e.target.value))); }} /></Field>;
  if (k === 'string') return <Field label="Value" required><Input value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value, e.target.value.trim().length > 0); }} /></Field>;
  if (k === 'list') return (
    <Field label="Values" required hint="One per line.">
      <Textarea rows={8} value={text} onChange={(e) => { setText(e.target.value); const l = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); onChange(l, l.length > 0); }} />
    </Field>
  );
  if (k === 'map') {
    const numeric = (key: string) => typeof (item.value as Record<string, unknown>)[key] === 'number';
    const commit = (next: [string, string][]) => {
      setRows(next);
      const out: Record<string, unknown> = {};
      let ok = next.length > 0;
      for (const [a, b] of next) {
        if (!a.trim()) { ok = false; continue; }
        const orig = (item.value as Record<string, unknown>)[a];
        if (typeof orig === 'number' || (orig === undefined && b.trim() !== '' && Number.isFinite(Number(b)) && Object.values(item.value as object).every((x) => typeof x === 'number'))) { const n = Number(b); if (b.trim() === '' || !Number.isFinite(n)) ok = false; out[a] = n; }
        else if (typeof orig === 'boolean') out[a] = b === 'true';
        else out[a] = b;
      }
      onChange(out, ok);
    };
    return (
      <div className="stack-sm">
        <span className="field__label">Entries</span>
        {rows.map(([a, b], i) => (
          <div key={i} className="row">
            <Input aria-label={`Key ${i + 1}`} value={a} onChange={(e) => commit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
            <Input aria-label={`Value ${i + 1}`} type={numeric(a) ? 'number' : 'text'} step="any" value={b} onChange={(e) => commit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
            <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => commit(rows.filter((_, j) => j !== i))}>Remove entry {i + 1}</Button>
          </div>
        ))}
        <div><Button size="sm" icon={<Plus />} onClick={() => commit([...rows, ['', '']])}>Add entry</Button></div>
      </div>
    );
  }
  return (
    <Field label="Value (JSON)" required hint="Structured setting. It must stay valid JSON in the same shape as today." error={jsonErr}>
      <Textarea rows={14} className="mono" style={{ fontSize: 12 }} value={text} onChange={(e) => {
        setText(e.target.value);
        try { const v = JSON.parse(e.target.value); setJsonErr(null); onChange(v, true); } catch (err) { setJsonErr(`Not valid JSON: ${(err as Error).message}`); onChange(null, false); }
      }} />
    </Field>
  );
}

function EditDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const [value, setValue] = useState<unknown>(item.value);
  const [valid, setValid] = useState(true);
  const [reason, setReason] = useState('');
  const act = useAction(() => api.put<{ status: string; version?: number; approval?: string; message?: string }>(`/config/${item.key}`, { value, reason }), {
    success: (r) => (r.status === 'Pending approval' ? `Change to ${item.label} sent for approval (${r.approval})` : `${item.label} updated to version ${r.version}`), invalidate: [['admin'], ['meta']], silentError: true, onSuccess: onClose,
  });
  const same = JSON.stringify(value) === JSON.stringify(item.value);
  return (
    <Modal open onClose={onClose} wide title={`Edit: ${item.label}`} sub={item.description}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={item.requires_approval ? 'decision' : 'deep'} loading={act.busy} disabled={!valid || same || reason.trim().length < 10} onClick={act.fire}>{item.requires_approval ? 'Send change for approval' : 'Save new version'}</Button></>}>
      <div className="stack">
        <ErrorSummary error={act.error} />
        {item.decision_ref && <Callout tone="decision" title={<>Pending Equipcare decision <DecisionTag id={item.decision_ref} /></>}>The current value is a proposed default. Saving records your input; it does not mean the decision is made.</Callout>}
        {item.requires_approval ? <Callout tone="decision" title="Needs approval">This change is held as pending until finance and procurement approve. The active version stays in force meanwhile.</Callout> : null}
        <div className="small muted">Current: {show(item.value)} (version {item.version})</div>
        <ValueEditor item={item} value={value} onChange={(v, ok) => { setValue(v); setValid(ok); }} error={!valid} />
        <Field label="Reason for the change" required hint="At least 10 characters. Recorded with the new version and in the audit trail."><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

function HistoryDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const q = useQuery<{ id: number; value: unknown; version: number | null; status: string; reason: string | null; requested_by_name: string | null; requested_at: string; effective_from: string | null }[]>({ queryKey: ['admin', 'config', 'history', item.key], queryFn: () => api.get(`/config/${item.key}/history`) });
  return (
    <Modal open onClose={onClose} wide title={`History: ${item.label}`} footer={<Button variant="deep" onClick={onClose}>Close</Button>}>
      <Loader q={q} rows={4}>{(rows) => (
        <ol className="timeline">
          {rows.map((h) => (
            <li key={h.id}>
              <span className="timeline__dot" data-tone={h.status === 'Active' ? 'ok' : h.status === 'Pending' ? 'warn' : undefined} />
              <div className="timeline__title">{h.version ? `Version ${h.version}` : 'Proposed'} <Status value={h.status} /></div>
              <div className="timeline__meta">{h.requested_by_name ?? 'System'} · {fmtDateTime(h.requested_at)}{h.effective_from ? ` · effective ${fmtDateTime(h.effective_from)}` : ''}</div>
              <div className="timeline__body">{show(h.value)}</div>
              {h.reason && <div className="timeline__body">Reason: {h.reason}</div>}
            </li>
          ))}
        </ol>
      )}</Loader>
    </Modal>
  );
}
