import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CopyPlus, Plus, PowerOff, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Badge, Button, Callout, Card, DecisionTag, Empty, Loader, PageHeader, Segmented, Status } from '@/components/ui';
import { Checkbox, ErrorSummary, Field, Input, Select, Textarea } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';

interface Level { level: number; roles: string[]; label?: string }
interface MRow {
  id: number; version: number; type: string; type_label: string; category: string; name: string; conditions: { min_value?: number; max_value?: number; urgency?: string[]; category?: string[] } | null;
  levels: Level[]; effective_from: string; active: number; created_at: string; note: string | null; created_by_name: string | null; in_effect: boolean; requests: number;
}
interface Data { rows: MRow[]; types: { id: string; label: string; category: string; has_rule: boolean }[]; roles: { code: string; label: string }[]; categories: { code: string; name: string }[]; urgencies: string[] }

const condText = (r: MRow) => {
  const c = r.conditions ?? {};
  const parts: string[] = [];
  if (c.min_value != null && c.max_value != null) parts.push(`${fmtMoney(c.min_value, true)} – ${fmtMoney(c.max_value, true)}`);
  else if (c.min_value != null) parts.push(`Above ${fmtMoney(c.min_value, true)}`);
  else if (c.max_value != null) parts.push(`Up to ${fmtMoney(c.max_value, true)}`);
  if (c.urgency?.length) parts.push(`Urgency: ${c.urgency.join(', ')}`);
  if (c.category?.length) parts.push(`Category: ${c.category.join(', ')}`);
  return parts.length ? parts.join(' · ') : 'Any request of this type';
};

export default function MatrixPage() {
  const { can } = useAuth();
  const q = useQuery<Data>({ queryKey: ['approvals', 'matrix'], queryFn: () => api.get('/approvals/matrix') });
  const [show, setShow] = useState<'active' | 'all'>('active');
  const [edit, setEdit] = useState<{ base?: MRow } | null>(null);
  const [off, setOff] = useState<MRow | null>(null);
  const admin = can('adm.config');
  const deact = useAction((reason: string) => api.post<{ message?: string }>(`/approvals/matrix/${off!.id}/deactivate`, { reason }), { success: (r) => r.message ?? 'Matrix row deactivated', invalidate: [['approvals', 'matrix']] });

  return (
    <>
      <PageHeader title="Approval matrix" screen="SCR-ADM-02" eyebrow="Administration" badges={<><Badge tone="decision">Placeholder pending DEC-13</Badge></>}
        sub="Who approves what, by value, urgency and category. Every request stores the matrix version it was routed with. Changes create a new version; existing requests keep the version they started with."
        actions={admin ? <Button variant="primary" icon={<Plus />} onClick={() => setEdit({})}>New rule</Button> : undefined} />
      <Callout tone="decision" title="Values are placeholders">The amounts, levels and approvers below are illustrative until Equipcare provides the approved authority matrix <DecisionTag id="DEC-13" />. {admin ? 'Replace them by creating new versions.' : 'Only a system administrator can change them; you can see how requests are routed.'}</Callout>
      <div style={{ height: 16 }} />
      <Loader q={q}>{(d) => {
        const rows = d.rows.filter((r) => show === 'all' || r.active);
        const byType = d.types.map((t) => ({ t, rows: rows.filter((r) => r.type === t.id) })).filter((g) => g.rows.length || (show === 'active' && !g.t.has_rule));
        return (
          <div className="stack">
            <div className="row between"><Segmented label="Show" value={show} onChange={setShow} options={[{ id: 'active', label: 'Active rows' }, { id: 'all', label: 'Including inactive versions' }]} />
              <span className="small muted">{d.rows.filter((r) => r.active).length} active rows across {d.types.filter((t) => t.has_rule).length} request types</span></div>
            {byType.map(({ t, rows: rs }) => (
              <Card key={t.id} title={<div className="row-wrap"><h2>{t.label}</h2><span className="mono small subtle">{t.id}</span>{t.category === 'exception' && <Badge tone="decision">Exception</Badge>}</div>} flush
                actions={admin ? <Button size="sm" icon={<CopyPlus />} onClick={() => setEdit({ base: { type: t.id } as MRow })}>Add rule</Button> : undefined}>
                {rs.length === 0 ? <div style={{ padding: 16 }}><Callout tone="warn" title="No active rule">New requests of this type fall back to the Procurement Manager (single level) until a rule is added.</Callout></div> : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead><tr><th>Rule</th><th>Applies when</th><th>Approval levels</th><th>Version</th><th>Effective</th><th className="num">Requests</th><th /></tr></thead>
                      <tbody>{rs.map((r) => (
                        <tr key={r.id} style={{ opacity: r.active ? 1 : 0.6 }}>
                          <td><strong>{r.name}</strong>{r.note && <div className="small muted" style={{ maxWidth: 260, whiteSpace: 'normal' }}>{r.note}</div>}</td>
                          <td style={{ whiteSpace: 'normal', minWidth: 180 }}>{condText(r)}</td>
                          <td style={{ whiteSpace: 'normal', minWidth: 220 }}>
                            {r.levels.map((l) => <div key={l.level} className="small"><strong>L{l.level}</strong> {l.roles.map((x) => d.roles.find((y) => y.code === x)?.label ?? x).join(' + ')}{l.roles.length > 1 ? <Badge tone="info" plain> parallel</Badge> : null}{l.label ? <span className="muted"> — {l.label}</span> : null}</div>)}
                          </td>
                          <td><span className="mono">v{r.version}</span></td>
                          <td className="nowrap">{fmtDate(r.effective_from)}<div className="small"><Status value={!r.active ? 'Inactive' : r.in_effect ? 'Active' : 'Pending'} tone={!r.active ? 'neutral' : r.in_effect ? 'ok' : 'warn'} /></div></td>
                          <td className="num">{r.requests}</td>
                          <td className="right nowrap">{admin && r.active && <><Button size="sm" variant="ghost" icon={<CopyPlus />} onClick={() => setEdit({ base: r })}>New version</Button><Button size="sm" variant="ghost" icon={<PowerOff />} onClick={() => setOff(r)}>Deactivate</Button></>}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </Card>
            ))}
            {byType.length === 0 && <Card><Empty title="No matrix rows">Create the first rule with “New rule”.</Empty></Card>}
          </div>
        );
      }}</Loader>
      {edit && q.data && <RuleDialog data={q.data} base={edit.base} onClose={() => setEdit(null)} />}
      <ReasonDialog open={!!off} onClose={() => setOff(null)} title={`Deactivate “${off?.name}”`} confirmLabel="Deactivate" variant="danger" sub="New requests stop using this row. Requests already routed keep their stored version." onSubmit={(r) => deact.run(r)} />
    </>
  );
}

function RuleDialog({ data, base, onClose }: { data: Data; base?: MRow; onClose: () => void }) {
  const isVersion = !!base?.id;
  const [type, setType] = useState(base?.type ?? '');
  const [name, setName] = useState(base?.name ?? '');
  const [min, setMin] = useState(base?.conditions?.min_value != null ? String(base.conditions.min_value) : '');
  const [max, setMax] = useState(base?.conditions?.max_value != null ? String(base.conditions.max_value) : '');
  const [urg, setUrg] = useState<string[]>(base?.conditions?.urgency ?? []);
  const [cats, setCats] = useState<string[]>(base?.conditions?.category ?? []);
  const [levels, setLevels] = useState<Level[]>(base?.levels?.length ? base.levels.map((l) => ({ ...l })) : [{ level: 1, roles: ['APR'], label: '' }]);
  const [eff, setEff] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [replace, setReplace] = useState(isVersion);
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const save = useAction(() => api.post('/approvals/matrix', {
    type, name, conditions: { min_value: min === '' ? null : Number(min), max_value: max === '' ? null : Number(max), urgency: urg, category: cats },
    levels: levels.map((l, i) => ({ level: i + 1, roles: l.roles, label: l.label || null })), effective_from: eff, note: note || null, replaces_id: replace && isVersion ? base!.id : null,
  }), { success: 'New matrix version saved', invalidate: [['approvals']], onSuccess: onClose, silentError: true });
  const typeOpts = useMemo(() => data.types.map((t) => ({ value: t.id, label: t.label })), [data.types]);
  return (
    <Modal open onClose={onClose} wide title={isVersion ? `New version of “${base!.name}”` : 'New approval rule'} sub="Saved as the next version number for this request type. Marked a placeholder until DEC-13 is decided."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={save.busy} disabled={!type || name.trim().length < 3} onClick={save.fire}>Save new version</Button></>}>
      <div className="stack">
        <ErrorSummary error={save.error} />
        <div className="form-grid">
          <Field label="Request type" required><Select value={type} onChange={(e) => setType(e.target.value)} placeholder="Choose a type" options={typeOpts} disabled={isVersion} /></Field>
          <Field label="Rule name" required><Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Award ₹5–25 lakh" /></Field>
          <Field label="Minimum value (₹)" hint="Leave empty for no lower limit."><Input type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} /></Field>
          <Field label="Maximum value (₹)" hint="Leave empty for no upper limit."><Input type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} /></Field>
        </div>
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted" style={{ fontWeight: 600 }}>Urgency (none selected = any)</legend>
          <div className="row-wrap">{data.urgencies.map((u) => <Checkbox key={u} label={u} checked={urg.includes(u)} onChange={() => toggle(urg, u, setUrg)} />)}</div>
        </fieldset>
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted" style={{ fontWeight: 600 }}>Spend category (none selected = any)</legend>
          <div className="row-wrap">{data.categories.map((c) => <Checkbox key={c.code} label={`${c.code}`} title={c.name} checked={cats.includes(c.code)} onChange={() => toggle(cats, c.code, setCats)} />)}</div>
        </fieldset>
        <div className="stack-sm">
          <div className="row between"><strong>Approval levels</strong><Button size="sm" icon={<Plus />} onClick={() => setLevels([...levels, { level: levels.length + 1, roles: ['APR'], label: '' }])}>Add level</Button></div>
          <p className="small muted" style={{ margin: 0 }}>Levels run in order. Choose more than one role in a level for parallel approval — every selected role must approve.</p>
          {levels.map((l, i) => (
            <div key={i} className="card" style={{ padding: 12 }}>
              <div className="row between"><strong>Level {i + 1}</strong>{levels.length > 1 && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => setLevels(levels.filter((_, j) => j !== i))}>Remove level {i + 1}</Button>}</div>
              <div className="row-wrap" style={{ margin: '6px 0' }}>{data.roles.map((r) => <Checkbox key={r.code} label={r.label} checked={l.roles.includes(r.code)} onChange={() => setLevels(levels.map((x, j) => (j === i ? { ...x, roles: x.roles.includes(r.code) ? x.roles.filter((y) => y !== r.code) : [...x.roles, r.code] } : x)))} />)}</div>
              <Field label="Label (shown to approvers)"><Input value={l.label ?? ''} maxLength={80} onChange={(e) => setLevels(levels.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="e.g. Finance" /></Field>
            </div>
          ))}
        </div>
        <div className="form-grid">
          <Field label="Effective from" required hint="Requests raised before this date keep the earlier version."><Input type="date" value={eff} onChange={(e) => setEff(e.target.value)} /></Field>
          {isVersion && <Field label="Previous version"><Checkbox label={`Deactivate “${base!.name}” (v${base!.version})`} checked={replace} onChange={(e) => setReplace(e.target.checked)} /></Field>}
        </div>
        <Field label="Note" hint="Optional. Kept with the version and in the audit trail."><Textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
