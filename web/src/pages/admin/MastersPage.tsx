/** SCR-ADM-03 master mappings: buyer matrix, spend categories, material-group map, plants. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { Badge, Button, Card, PageHeader, Status, Tabs } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { Checkbox, ErrorSummary, Field, Input, Select, fieldError } from '@/components/forms';
import { Modal, ReasonDialog } from '@/components/overlay';

type Tab = 'buyers' | 'categories' | 'groups' | 'plants';

export default function MastersPage() {
  const [tab, setTab] = useState<Tab>('buyers');
  return (
    <>
      <PageHeader title="Master mappings" screen="SCR-ADM-03" eyebrow={<Link to="/admin">Administration</Link>} sub="Platform-owned mappings that drive PR assignment, RFQ minimum vendor counts and landed-cost GST treatment. Vendor capability approvals are in Vendors › Capability proposals." />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'buyers', label: 'Buyer assignment' }, { id: 'categories', label: 'Spend categories' }, { id: 'groups', label: 'Material group map' }, { id: 'plants', label: 'Plants' }]} />
      {tab === 'buyers' && <Buyers />}
      {tab === 'categories' && <Categories />}
      {tab === 'groups' && <Groups />}
      {tab === 'plants' && <Plants />}
    </>
  );
}

const inv = [['admin', 'masters']];

// ------------------------------------------------------------------ buyer matrix
function Buyers() {
  const q = useQuery<any[]>({ queryKey: ['admin', 'masters', 'matrix'], queryFn: () => api.get('/admin/buyer-matrix') });
  const buyers = useQuery<{ id: number; name: string }[]>({ queryKey: ['admin', 'masters', 'buyers'], queryFn: () => api.get('/admin/buyers') });
  const cats = useQuery<any[]>({ queryKey: ['admin', 'masters', 'cats'], queryFn: () => api.get('/admin/categories') });
  const plants = useQuery<any[]>({ queryKey: ['admin', 'masters', 'plants'], queryFn: () => api.get('/admin/plants') });
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const remove = useAction((id: number, reason: string) => api.post(`/admin/buyer-matrix/${id}/delete`, { reason }), { success: 'Matrix row deleted', invalidate: inv });
  const unmapped = (cats.data ?? []).filter((c) => !c.matrix_rows);
  return (
    <div className="stack">
      {unmapped.length > 0 && <Card><span className="small">No active buyer for: <strong>{unmapped.map((c) => c.code).join(', ')}</strong>. PR lines in these categories land in the manager's unassigned queue (FR-PRW-03).</span></Card>}
      <Card flush title="Buyer assignment matrix" actions={<Button size="sm" variant="deep" icon={<Plus />} onClick={() => setEdit('new')}>Add row</Button>}>
        <DataTable<any>
          id="admin-matrix" rows={q.data} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.id}
          columns={[
            { key: 'category', header: 'Category', render: (r) => <><strong>{r.category}</strong> <span className="small muted">{r.category_name}</span></> },
            { key: 'plant', header: 'Plant', render: (r) => (r.plant === '*' ? 'All plants' : r.plant) },
            { key: 'priority_route', header: 'Priority', render: (r) => (r.priority_route === '*' ? 'Any' : r.priority_route) },
            { key: 'buyer_name', header: 'Buyer' }, { key: 'backup_name', header: 'Backup buyer', render: (r) => r.backup_name ?? '—' },
            { key: 'active', header: 'Active', render: (r) => (r.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>), value: (r) => (r.active ? 'Active' : 'Inactive') },
            { key: 'act', header: '', sortable: false, exportable: false, render: (r) => <div className="row"><Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEdit(r)}>Edit</Button><Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setDel(r)}>Delete</Button></div> },
          ]}
          filters={[{ key: 'category', label: 'Category', value: (r) => r.category }, { key: 'buyer', label: 'Buyer', value: (r) => r.buyer_name }]}
          mobile={{ title: (r) => `${r.category} → ${r.buyer_name}`, badge: (r) => (r.active ? <Status value="Active" /> : <Status value="Inactive" />), meta: (r) => [r.plant === '*' ? 'All plants' : r.plant, r.priority_route === '*' ? 'Any priority' : r.priority_route] }}
          empty={<div className="empty"><div className="empty__title">No buyer rows</div><div>Add a row so new PR lines are assigned automatically.</div></div>}
        />
      </Card>
      {edit && <MatrixDialog row={edit === 'new' ? null : edit} cats={cats.data ?? []} plants={plants.data ?? []} buyers={buyers.data ?? []} onClose={() => setEdit(null)} />}
      <ReasonDialog open={!!del} onClose={() => setDel(null)} title={`Delete ${del?.category} row`} sub="Lines in this category will fall back to other rows or the unassigned queue." confirmLabel="Delete row" variant="danger" onSubmit={(r) => remove.run(del.id, r)} />
    </div>
  );
}

function MatrixDialog({ row, cats, plants, buyers, onClose }: { row: any | null; cats: any[]; plants: any[]; buyers: { id: number; name: string }[]; onClose: () => void }) {
  const [f, setF] = useState({ category: row?.category ?? '', plant: row?.plant ?? '*', priority_route: row?.priority_route ?? '*', buyer_id: row ? String(row.buyer_id) : '', backup_buyer_id: row?.backup_buyer_id ? String(row.backup_buyer_id) : '', active: row ? !!row.active : true });
  const save = useAction(() => {
    const body = { category: f.category, plant: f.plant, priority_route: f.priority_route, buyer_id: Number(f.buyer_id), backup_buyer_id: f.backup_buyer_id ? Number(f.backup_buyer_id) : null, active: f.active };
    return row ? api.put(`/admin/buyer-matrix/${row.id}`, body) : api.post('/admin/buyer-matrix', body);
  }, { success: row ? 'Matrix row updated' : 'Matrix row added', invalidate: inv, silentError: true, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={row ? 'Edit matrix row' : 'Add matrix row'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={save.busy} disabled={!f.category || !f.buyer_id} onClick={save.fire}>Save row</Button></>}>
      <div className="stack">
        <ErrorSummary error={save.error} />
        <Field label="Spend category" required error={fieldError(save.error, 'category')}><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Choose" options={cats.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))} /></Field>
        <div className="form-grid">
          <Field label="Plant"><Select value={f.plant} onChange={(e) => setF({ ...f, plant: e.target.value })} options={[{ value: '*', label: 'All plants' }, ...plants.map((p) => ({ value: p.code, label: `${p.code} ${p.name}` }))]} /></Field>
          <Field label="Priority"><Select value={f.priority_route} onChange={(e) => setF({ ...f, priority_route: e.target.value })} options={[{ value: '*', label: 'Any' }, 'Normal', 'Urgent', 'BD', 'Class 1']} /></Field>
        </div>
        <Field label="Buyer" required error={fieldError(save.error, 'buyer_id')}><Select value={f.buyer_id} onChange={(e) => setF({ ...f, buyer_id: e.target.value })} placeholder="Choose a buyer" options={buyers.map((b) => ({ value: b.id, label: b.name }))} /></Field>
        <Field label="Backup buyer" error={fieldError(save.error, 'backup_buyer_id')}><Select value={f.backup_buyer_id} onChange={(e) => setF({ ...f, backup_buyer_id: e.target.value })} placeholder="None" options={buyers.filter((b) => String(b.id) !== f.buyer_id).map((b) => ({ value: b.id, label: b.name }))} /></Field>
        <Checkbox label="Active" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ categories
function Categories() {
  const q = useQuery<any[]>({ queryKey: ['admin', 'masters', 'cats'], queryFn: () => api.get('/admin/categories') });
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const remove = useAction((code: string, reason: string) => api.post(`/admin/categories/${code}/delete`, { reason }), { success: 'Category deleted', invalidate: inv });
  return (
    <>
      <Card flush title="Spend categories" actions={<Button size="sm" variant="deep" icon={<Plus />} onClick={() => setEdit('new')}>Add category</Button>}>
        <DataTable<any>
          id="admin-categories" rows={q.data} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.code}
          columns={[
            { key: 'code', header: 'Code', render: (r) => <span className="mono">{r.code}</span> }, { key: 'name', header: 'Name', render: (r) => <strong>{r.name}</strong> },
            { key: 'parent', header: 'Parent', render: (r) => r.parent ?? '—' }, { key: 'min_vendors', header: 'Min. vendors', align: 'right' },
            { key: 'itc_recoverable', header: 'GST (ITC)', render: (r) => (r.itc_recoverable ? <Badge tone="ok" plain>ITC recoverable</Badge> : <Badge tone="warn" plain>GST is a cost</Badge>), value: (r) => (r.itc_recoverable ? 'Recoverable' : 'Cost') },
            { key: 'rfq_rule', header: 'RFQ rule', render: (r) => r.rfq_rule ?? '—' },
            { key: 'usage', header: 'Used by', render: (r) => <span className="small muted">{r.materials} materials · {r.groups} groups · {r.vendors} vendor rows · {r.matrix_rows} buyer rows</span>, sortable: false },
            { key: 'act', header: '', sortable: false, exportable: false, render: (r) => <div className="row"><Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEdit(r)}>Edit</Button><Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setDel(r)}>Delete</Button></div> },
          ]}
          mobile={{ title: (r) => `${r.code} — ${r.name}`, meta: (r) => [`Min ${r.min_vendors} vendors`, r.itc_recoverable ? 'ITC recoverable' : 'GST is a cost'] }}
        />
      </Card>
      <p className="small muted" style={{ marginTop: 8 }}>Minimum vendors drives the RFQ rule (FR-RFQ-11); the ITC flag drives GST treatment in the comparative statement (DEC-21).</p>
      {edit && <CategoryDialog row={edit === 'new' ? null : edit} cats={q.data ?? []} onClose={() => setEdit(null)} />}
      <ReasonDialog open={!!del} onClose={() => setDel(null)} title={`Delete category ${del?.code}`} sub="Only categories nothing refers to can be deleted." confirmLabel="Delete category" variant="danger" onSubmit={(r) => remove.run(del.code, r)} />
    </>
  );
}

function CategoryDialog({ row, cats, onClose }: { row: any | null; cats: any[]; onClose: () => void }) {
  const [f, setF] = useState({ code: row?.code ?? '', name: row?.name ?? '', parent: row?.parent ?? '', min_vendors: String(row?.min_vendors ?? 3), rfq_rule: row?.rfq_rule ?? '', itc: row ? !!row.itc_recoverable : true, description: row?.description ?? '' });
  const save = useAction(() => {
    const body = { name: f.name, parent: f.parent || null, min_vendors: Number(f.min_vendors), rfq_rule: f.rfq_rule || null, itc_recoverable: f.itc, description: f.description || null };
    return row ? api.put(`/admin/categories/${row.code}`, body) : api.post('/admin/categories', { ...body, code: f.code });
  }, { success: row ? 'Category updated' : 'Category added', invalidate: inv, silentError: true, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={row ? `Edit ${row.code}` : 'Add category'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={save.busy} disabled={!f.name || !f.code} onClick={save.fire}>Save category</Button></>}>
      <div className="stack">
        <ErrorSummary error={save.error} />
        <div className="form-grid">
          <Field label="Code" required hint="2–6 letters" error={fieldError(save.error, 'code')}><Input className="mono" disabled={!!row} maxLength={6} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Minimum vendors per RFQ" required error={fieldError(save.error, 'min_vendors')}><Input type="number" min={1} max={20} value={f.min_vendors} onChange={(e) => setF({ ...f, min_vendors: e.target.value })} /></Field>
          <Field label="Name" required className="span-2" error={fieldError(save.error, 'name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Parent category"><Select value={f.parent} onChange={(e) => setF({ ...f, parent: e.target.value })} placeholder="None" options={cats.filter((c) => c.code !== row?.code).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))} /></Field>
          <Field label="RFQ rule note"><Input value={f.rfq_rule} onChange={(e) => setF({ ...f, rfq_rule: e.target.value })} /></Field>
          <Field label="Description" className="span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </div>
        <Checkbox label="GST input tax credit is recoverable (landed cost excludes GST)" checked={f.itc} onChange={(e) => setF({ ...f, itc: e.target.checked })} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ material groups
function Groups() {
  const q = useQuery<any[]>({ queryKey: ['admin', 'masters', 'groups'], queryFn: () => api.get('/admin/material-groups') });
  const cats = useQuery<any[]>({ queryKey: ['admin', 'masters', 'cats'], queryFn: () => api.get('/admin/categories') });
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const remove = useAction((g: string, reason: string) => api.post(`/admin/material-groups/${g}/delete`, { reason }), { success: 'Mapping deleted', invalidate: inv });
  return (
    <>
      <Card flush title="Material group → spend category" actions={<Button size="sm" variant="deep" icon={<Plus />} onClick={() => setEdit('new')}>Add mapping</Button>}>
        <DataTable<any>
          id="admin-groups" rows={q.data} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.material_group}
          columns={[
            { key: 'material_group', header: 'SAP material group', render: (r) => <span className="mono">{r.material_group}</span> },
            { key: 'category', header: 'Spend category', render: (r) => <>{r.category} <span className="small muted">{r.category_name}</span></> },
            { key: 'materials', header: 'Materials', align: 'right' },
            { key: 'mismatched', header: 'Not yet on this category', align: 'right', render: (r) => (r.mismatched ? <Badge tone="warn">{r.mismatched}</Badge> : <span className="subtle">0</span>) },
            { key: 'act', header: '', sortable: false, exportable: false, render: (r) => <div className="row"><Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEdit(r)}>Edit</Button><Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setDel(r)}>Delete</Button></div> },
          ]}
          filters={[{ key: 'category', label: 'Category', value: (r) => r.category }]}
          mobile={{ title: (r) => `${r.material_group} → ${r.category}`, meta: (r) => [`${r.materials} materials`] }}
        />
      </Card>
      <p className="small muted" style={{ marginTop: 8 }}>New SAP materials take the category of their material group when they sync. Existing materials change only if you choose “apply to existing materials”.</p>
      {edit && <GroupDialog row={edit === 'new' ? null : edit} cats={cats.data ?? []} onClose={() => setEdit(null)} />}
      <ReasonDialog open={!!del} onClose={() => setDel(null)} title={`Delete mapping ${del?.material_group}`} sub="New materials in this group will have no spend category until it is mapped again." confirmLabel="Delete mapping" variant="danger" onSubmit={(r) => remove.run(del.material_group, r)} />
    </>
  );
}

function GroupDialog({ row, cats, onClose }: { row: any | null; cats: any[]; onClose: () => void }) {
  const [f, setF] = useState({ material_group: row?.material_group ?? '', category: row?.category ?? '', apply: false });
  const save = useAction(() => {
    const body = { category: f.category, apply_to_materials: f.apply };
    return row ? api.put<{ materials_updated: number }>(`/admin/material-groups/${row.material_group}`, body) : api.post<{ materials_updated: number }>('/admin/material-groups', { ...body, material_group: f.material_group });
  }, { success: (r: any) => `Mapping saved${r.materials_updated ? `; ${r.materials_updated} materials updated` : ''}`, invalidate: inv, silentError: true, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={row ? `Edit ${row.material_group}` : 'Add mapping'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="deep" loading={save.busy} disabled={!f.material_group || !f.category} onClick={save.fire}>Save mapping</Button></>}>
      <div className="stack">
        <ErrorSummary error={save.error} />
        <Field label="SAP material group" required error={fieldError(save.error, 'material_group')}><Input className="mono" disabled={!!row} value={f.material_group} onChange={(e) => setF({ ...f, material_group: e.target.value.toUpperCase() })} /></Field>
        <Field label="Spend category" required error={fieldError(save.error, 'category')}><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Choose" options={cats.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))} /></Field>
        <Checkbox label="Apply to existing materials in this group" checked={f.apply} onChange={(e) => setF({ ...f, apply: e.target.checked })} />
      </div>
    </Modal>
  );
}

function Plants() {
  const q = useQuery<any[]>({ queryKey: ['admin', 'masters', 'plants'], queryFn: () => api.get('/admin/plants') });
  return (
    <Card flush title="Plants" actions={<Badge plain>Read only — plants come from SAP</Badge>}>
      <DataTable<any>
        id="admin-plants" rows={q.data} loading={q.isLoading} error={q.error} refetch={() => q.refetch()} rowKey={(r) => r.code} savedViews={false}
        columns={[{ key: 'code', header: 'Code', render: (r) => <span className="mono">{r.code}</span> }, { key: 'name', header: 'Name' }, { key: 'city', header: 'City' }, { key: 'state', header: 'State' }, { key: 'gstin', header: 'GSTIN', render: (r) => <span className="mono small">{r.gstin}</span> }, { key: 'ship_to_address', header: 'Ship-to address' }, { key: 'calendar', header: 'Calendar' }]}
        mobile={{ title: (r) => `${r.code} — ${r.name}`, meta: (r) => [r.city, r.state] }}
      />
    </Card>
  );
}
