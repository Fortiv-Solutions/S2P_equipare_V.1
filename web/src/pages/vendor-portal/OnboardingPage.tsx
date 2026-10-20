/** SCR-VPT-11 registration & onboarding stepper (FR-VPT-11). */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Plus, Trash2, Send, ChevronLeft, ChevronRight, Circle, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Badge, Button, Callout, Card, Loader, PageHeader, Status } from '@/components/ui';
import { ErrorSummary, Field, Input, Select, Textarea, Checkbox, fieldError } from '@/components/forms';
import { TrackChain } from '@/components/TrackChain';
import { FileDrop, type Uploaded } from '@/components/Attachments';
import { Modal } from '@/components/overlay';
import { DocStatus, Expiry, fileLink, onboardingChain } from '../vendors/shared';

type Step = 'company' | 'tax' | 'msme' | 'bank' | 'contacts' | 'documents' | 'capabilities' | 'submit';
const STEPS: { id: Step; label: string }[] = [
  { id: 'company', label: 'Company' }, { id: 'tax', label: 'GSTIN & PAN' }, { id: 'msme', label: 'MSME' }, { id: 'bank', label: 'Bank' },
  { id: 'contacts', label: 'Contacts' }, { id: 'documents', label: 'Documents' }, { id: 'capabilities', label: 'What you supply' }, { id: 'submit', label: 'Review & submit' },
];

export default function OnboardingPage() {
  const q = useQuery<any>({ queryKey: ['vendor-onboarding'], queryFn: () => api.get('/vendors/me/onboarding') });
  return (
    <>
      <PageHeader title="Registration & onboarding" screen="SCR-VPT-11" sub="Complete your company details, tax and bank information, documents and capabilities. Equipcare procurement and finance then review the application." />
      <Loader q={q} rows={8}>{(o) => <Stepper o={o} />}</Loader>
    </>
  );
}

function Stepper({ o }: { o: any }) {
  const v = o.vendor;
  const [step, setStep] = useState<Step>('company');
  const check = (k: string) => o.checklist.find((c: any) => c.key === k)?.ok;
  const done: Record<Step, boolean> = {
    company: check('company'), tax: check('tax'), msme: !!v.msme_no || check('company'), bank: check('bank'), contacts: check('contacts'),
    documents: o.checklist.filter((c: any) => c.key.startsWith('doc:')).every((c: any) => c.ok), capabilities: check('capabilities'), submit: !o.editable,
  };
  const idx = STEPS.findIndex((s) => s.id === step);
  const status = v.onboarding_status;
  return (
    <div className="stack">
      <Card title="Where you are" actions={<Status value={status} />}><TrackChain label="Onboarding stages" steps={onboardingChain(status)} /></Card>
      {status === 'Clarification requested' && o.clarification && (
        <>
          <Callout tone="warn" title="Equipcare needs more information">{o.clarification.note}<div className="small muted">Asked by {o.clarification.by_name} · {fmtDateTime(o.clarification.at)}</div></Callout>
          <Respond />
        </>
      )}
      {status === 'Rejected' && <Callout tone="bad" title="Your application was not approved">{o.rejected_reason ?? 'No reason was recorded.'} Raise a ticket if you want to discuss it. <Link to="/vendor/tickets/new">Raise a ticket</Link></Callout>}
      {['Submitted', 'Under review'].includes(status) && <Callout tone="info" title="Application submitted">Submitted {fmtDateTime(o.submitted_at)}. Procurement and finance are reviewing your documents, bank details and capabilities. You will be notified of every step; you cannot edit unless Equipcare asks for a clarification.</Callout>}
      {status === 'Pending SAP code' && <Callout tone="ok" title="Approved — waiting for your SAP vendor code">Equipcare’s SAP team is creating your vendor record. Full portal access (RFQs, purchase orders, invoices, payments) opens when the code is linked. You do not need to do anything.</Callout>}
      {status === 'Active' && <Callout tone="ok" title="You are active">Your SAP vendor code is {v.sap_code}. <Link to="/vendor">Go to your home</Link>.</Callout>}

      <div className="onb-split">
        <nav aria-label="Onboarding steps" className="card" style={{ padding: 8 }}>
          <ol className="list-plain stack-sm" style={{ margin: 0 }}>
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <button className="menu__item" style={{ width: '100%', fontWeight: step === s.id ? 700 : 500, background: step === s.id ? 'var(--amber-50)' : undefined }} aria-current={step === s.id ? 'step' : undefined} onClick={() => setStep(s.id)}>
                  {done[s.id] ? <CheckCircle2 size={16} color="var(--ok)" aria-hidden /> : <Circle size={16} color="var(--text-3)" aria-hidden />}
                  <span>{i + 1}. {s.label}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="stack">
          {step === 'company' && <Company o={o} />}
          {step === 'tax' && <Tax o={o} />}
          {step === 'msme' && <Msme o={o} />}
          {step === 'bank' && <Bank o={o} />}
          {step === 'contacts' && <Contacts o={o} />}
          {step === 'documents' && <Documents o={o} />}
          {step === 'capabilities' && <Capabilities o={o} />}
          {step === 'submit' && <Submit o={o} />}
          <div className="row between">
            <Button icon={<ChevronLeft />} disabled={idx === 0} onClick={() => setStep(STEPS[idx - 1].id)}>Back</Button>
            <Button variant="deep" disabled={idx === STEPS.length - 1} onClick={() => setStep(STEPS[idx + 1].id)}>Next <ChevronRight size={16} /></Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Respond() {
  const [m, setM] = useState('');
  const act = useAction(() => api.post('/vendors/me/onboarding/respond', { message: m }), { success: 'Answer sent to Equipcare', invalidate: [['vendor-onboarding']], onSuccess: () => setM('') });
  return (
    <Card title="Answer Equipcare">
      <div className="stack-sm">
        <Textarea rows={3} aria-label="Your answer" value={m} onChange={(e) => setM(e.target.value)} maxLength={2000} placeholder="Explain or confirm what Equipcare asked. Then update the form if needed and submit again." />
        <div><Button variant="deep" icon={<Send />} loading={act.busy} disabled={m.trim().length < 5} onClick={act.fire}>Send answer</Button></div>
      </div>
    </Card>
  );
}

function SectionForm({ o, section, title, sub, body, children, valid = true }: { o: any; section: string; title: string; sub?: string; body: () => Record<string, unknown>; children: (err: unknown) => React.ReactNode; valid?: boolean }) {
  const save = useAction(() => api.put('/vendors/me/onboarding', { section, ...body() }), { success: `${title} saved`, invalidate: [['vendor-onboarding'], ['me']], silentError: true });
  const locked = !o.editable;
  return (
    <Card title={title} actions={locked ? <Badge tone="info">Read only</Badge> : undefined}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save.fire(); }}>
        {sub && <p className="small muted" style={{ margin: 0 }}>{sub}</p>}
        <ErrorSummary error={save.error} />
        <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{children(save.error)}</fieldset>
        {!locked && <div><Button type="submit" variant="deep" icon={<Check />} loading={save.busy} disabled={!valid}>Save {title}</Button></div>}
      </form>
    </Card>
  );
}

function Company({ o }: { o: any }) {
  const v = o.vendor;
  const [f, setF] = useState({ legal_name: v.legal_name ?? '', name: v.name ?? '', address: v.address ?? '', city: v.city ?? '', state: v.state ?? '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <SectionForm o={o} section="company" title="Company details" body={() => f} valid={!!f.legal_name && !!f.address && !!f.city && !!f.state}>
      {(err) => (
        <div className="form-grid">
          <Field label="Legal name" required hint="Exactly as on your GST certificate." error={fieldError(err, 'legal_name')}><Input value={f.legal_name} onChange={set('legal_name')} /></Field>
          <Field label="Trade name"><Input value={f.name} onChange={set('name')} /></Field>
          <Field label="Registered address" required className="span-2" error={fieldError(err, 'address')}><Textarea rows={2} value={f.address} onChange={set('address')} /></Field>
          <Field label="City" required error={fieldError(err, 'city')}><Input value={f.city} onChange={set('city')} /></Field>
          <Field label="State" required hint="The GSTIN state code must match." error={fieldError(err, 'state')}><Select value={f.state} onChange={set('state')} placeholder="Choose a state" options={o.states} /></Field>
        </div>
      )}
    </SectionForm>
  );
}

function Tax({ o }: { o: any }) {
  const v = o.vendor;
  const [f, setF] = useState({ gstin: v.gstin ?? '', pan: v.pan ?? '' });
  const g = f.gstin.trim().toUpperCase();
  const p = f.pan.trim().toUpperCase();
  const fmtOk = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g);
  const panOk = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p);
  return (
    <SectionForm o={o} section="tax" title="GSTIN and PAN" sub="Checked for format, the GSTIN check character and that the PAN inside the GSTIN equals your PAN. Equipcare verifies against your certificates." body={() => ({ gstin: g, pan: p })} valid={!!g && !!p}>
      {(err) => (
        <div className="form-grid">
          <Field label="GSTIN" required hint={g ? (fmtOk ? 'Format looks right; the check character is verified when you save.' : 'Needs 15 characters, e.g. 27AAPFO6120K1Z5.') : undefined} error={fieldError(err, 'gstin')}>
            <Input className="mono" maxLength={15} value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="PAN" required hint={p && !panOk ? 'Needs 10 characters, e.g. AAPFO6120K.' : undefined} error={fieldError(err, 'pan')}>
            <Input className="mono" maxLength={10} value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} />
          </Field>
        </div>
      )}
    </SectionForm>
  );
}

function Msme({ o }: { o: any }) {
  const v = o.vendor;
  const [reg, setReg] = useState(!!v.msme_no);
  const [f, setF] = useState({ msme_no: v.msme_no ?? '', msme_category: v.msme_category ?? '' });
  return (
    <SectionForm o={o} section="msme" title="MSME registration" body={() => ({ registered: reg, ...f })} valid={!reg || (!!f.msme_no && !!f.msme_category)}>
      {(err) => (
        <>
          <Checkbox label="We are registered under MSME (Udyam)" checked={reg} onChange={(e) => setReg(e.target.checked)} />
          {reg && (
            <div className="form-grid" style={{ marginTop: 12 }}>
              <Field label="Udyam registration number" required hint="Format UDYAM-MH-26-0071234." error={fieldError(err, 'msme_no')}><Input className="mono" value={f.msme_no} onChange={(e) => setF({ ...f, msme_no: e.target.value.toUpperCase() })} /></Field>
              <Field label="Category" required error={fieldError(err, 'msme_category')}><Select value={f.msme_category} onChange={(e) => setF({ ...f, msme_category: e.target.value })} placeholder="Choose" options={['Micro', 'Small', 'Medium']} /></Field>
              <p className="small muted span-2" style={{ margin: 0 }}>The MSME / Udyam certificate then becomes a mandatory document.</p>
            </div>
          )}
        </>
      )}
    </SectionForm>
  );
}

function Bank({ o }: { o: any }) {
  const v = o.vendor;
  const [f, setF] = useState({ bank_name: v.bank_name ?? '', bank_ifsc: v.bank_ifsc ?? '', account_no: '', account_confirm: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <SectionForm o={o} section="bank" title="Bank account" sub={v.bank_account_masked ? `Saved account: ${v.bank_account_masked}. Enter the full number again to change it. The platform keeps only the masked number.` : 'Used for payments. Finance matches it with your cancelled cheque. The platform keeps only the masked number.'} body={() => f} valid={!!f.bank_name && !!f.bank_ifsc && !!f.account_no}>
      {(err) => (
        <div className="form-grid">
          <Field label="Bank name" required error={fieldError(err, 'bank_name')}><Input value={f.bank_name} onChange={set('bank_name')} /></Field>
          <Field label="IFSC" required error={fieldError(err, 'bank_ifsc')}><Input className="mono" maxLength={11} value={f.bank_ifsc} onChange={(e) => setF({ ...f, bank_ifsc: e.target.value.toUpperCase() })} /></Field>
          <Field label="Account number" required error={fieldError(err, 'account_no')}><Input inputMode="numeric" autoComplete="off" value={f.account_no} onChange={set('account_no')} /></Field>
          <Field label="Confirm account number" required error={fieldError(err, 'account_confirm')}><Input inputMode="numeric" autoComplete="off" value={f.account_confirm} onChange={set('account_confirm')} /></Field>
        </div>
      )}
    </SectionForm>
  );
}

function Contacts({ o }: { o: any }) {
  const [rows, setRows] = useState<{ name: string; role: string; email: string; phone: string }[]>(o.contacts.length ? o.contacts : [{ name: '', role: 'Primary contact', email: '', phone: '' }]);
  useEffect(() => { if (o.contacts.length) setRows(o.contacts); /* eslint-disable-next-line */ }, [JSON.stringify(o.contacts)]);
  const upd = (i: number, k: string, val: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: val } : r)));
  return (
    <SectionForm o={o} section="contacts" title="Contacts" sub="The first contact is the primary contact for RFQs and purchase orders." body={() => ({ contacts: rows })} valid={rows.every((r) => r.name && r.role && r.email && r.phone)}>
      {(err) => (
        <div className="stack">
          {fieldError(err, 'contacts') && <span className="field__error">{fieldError(err, 'contacts')}</span>}
          {rows.map((r, i) => (
            <div key={i} className="form-grid" style={{ borderBottom: '1px solid var(--steel-100)', paddingBottom: 12 }}>
              <Field label={`Contact ${i + 1} name`} required><Input value={r.name} onChange={(e) => upd(i, 'name', e.target.value)} /></Field>
              <Field label="Role" required><Input value={r.role} onChange={(e) => upd(i, 'role', e.target.value)} /></Field>
              <Field label="E-mail" required><Input type="email" value={r.email} onChange={(e) => upd(i, 'email', e.target.value)} /></Field>
              <Field label="Phone" required><Input value={r.phone} onChange={(e) => upd(i, 'phone', e.target.value)} placeholder="+91 98220 41100" /></Field>
              {rows.length > 1 && <div className="span-2"><Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove contact {i + 1}</Button></div>}
            </div>
          ))}
          {rows.length < 8 && <div><Button size="sm" icon={<Plus />} onClick={() => setRows([...rows, { name: '', role: '', email: '', phone: '' }])}>Add contact</Button></div>}
        </div>
      )}
    </SectionForm>
  );
}

export function DocumentUpload({ vendorId, types, mandatory, initialType, onDone, editable = true }: { vendorId: number; types: string[]; mandatory: string[]; initialType?: string; onDone?: () => void; editable?: boolean }) {
  const [f, setF] = useState({ doc_type: initialType ?? '', doc_no: '', issued_on: '', expiry_date: '' });
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [key, setKey] = useState(0);
  const save = useAction(() => api.post('/vendors/me/documents', { doc_type: f.doc_type, doc_no: f.doc_no || undefined, issued_on: f.issued_on || undefined, expiry_date: f.expiry_date || undefined, attachment_id: files[0].id }), {
    success: `${f.doc_type} uploaded for review`, invalidate: [['vendor-onboarding'], ['vendor-profile']], silentError: true,
    onSuccess: () => { setF({ doc_type: initialType ?? '', doc_no: '', issued_on: '', expiry_date: '' }); setFiles([]); setKey(key + 1); onDone?.(); },
  });
  if (!editable) return null;
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <strong>Upload a document</strong>
      <ErrorSummary error={save.error} />
      <div className="form-grid">
        <Field label="Document type" required error={fieldError(save.error, 'doc_type')}><Select value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value })} placeholder="Choose a type" options={types.map((t) => ({ value: t, label: `${t}${mandatory.includes(t) ? ' (mandatory)' : ''}` }))} /></Field>
        <Field label="Document number"><Input value={f.doc_no} onChange={(e) => setF({ ...f, doc_no: e.target.value })} /></Field>
        <Field label="Issued on"><Input type="date" value={f.issued_on} onChange={(e) => setF({ ...f, issued_on: e.target.value })} /></Field>
        <Field label="Expiry date" hint="Leave empty if it does not expire." error={fieldError(save.error, 'expiry_date')}><Input type="date" value={f.expiry_date} onChange={(e) => setF({ ...f, expiry_date: e.target.value })} /></Field>
      </div>
      <FileDrop key={key} ownerType="vendor" ownerId={vendorId} label={f.doc_type || 'Document file'} multiple={false} compact camera onUploaded={setFiles} />
      <div><Button variant="deep" icon={<Check />} loading={save.busy} disabled={!f.doc_type || !files.length} onClick={save.fire}>Save document</Button></div>
    </div>
  );
}

function Documents({ o }: { o: any }) {
  const rows = o.documents.filter((d: any) => d.status !== 'Superseded');
  return (
    <Card title="Documents" actions={<span className="small muted">Mandatory: {o.mandatory_types.join(', ')}</span>}>
      <div className="stack">
        <ul className="list-plain stack-sm">
          {o.mandatory_types.map((t: string) => {
            const d = rows.find((x: any) => x.doc_type === t && x.attachment_id);
            return (
              <li key={t} className="row between" style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', flexWrap: 'wrap' }}>
                <span className="row">{d ? <CheckCircle2 size={16} color="var(--ok)" aria-hidden /> : <Circle size={16} color="var(--text-3)" aria-hidden />}<strong>{t}</strong></span>
                <span className="row-wrap">{d ? <>{fileLink(d.attachment_id, d.filename)}<DocStatus d={d} /></> : <Badge tone="warn">Not uploaded</Badge>}</span>
              </li>
            );
          })}
        </ul>
        {rows.filter((d: any) => !o.mandatory_types.includes(d.doc_type) && d.attachment_id).map((d: any) => (
          <div key={d.id} className="row between small"><span>{d.doc_type} · {fileLink(d.attachment_id, d.filename)}</span><span className="row"><Expiry date={d.expiry_date} /><DocStatus d={d} /></span></div>
        ))}
        <DocumentUpload vendorId={o.vendor.id} types={o.document_types} mandatory={o.mandatory_types} editable={o.editable} />
      </div>
    </Card>
  );
}

export function CapabilityForm({ categories, roles, onDone }: { categories: { code: string; name: string }[]; roles: string[]; onDone?: () => void }) {
  const [f, setF] = useState({ category: '', sub_category: '', supplier_role: '', brand: '', region: '' });
  const add = useAction(() => api.post('/vendors/me/capabilities', { ...f, sub_category: f.sub_category || undefined, supplier_role: f.supplier_role || undefined, brand: f.brand || undefined, region: f.region || undefined }), {
    success: 'Capability proposed — procurement will review it', invalidate: [['vendor-onboarding'], ['vendor-profile']], silentError: true, onSuccess: () => { setF({ category: '', sub_category: '', supplier_role: '', brand: '', region: '' }); onDone?.(); },
  });
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <strong>Propose what you supply</strong>
      <ErrorSummary error={add.error} />
      <div className="form-grid">
        <Field label="Category" required error={fieldError(add.error, 'category')}><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Choose a category" options={categories.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))} /></Field>
        <Field label="Sub-category" hint="e.g. Seal kits, Track rollers"><Input value={f.sub_category} onChange={(e) => setF({ ...f, sub_category: e.target.value })} /></Field>
        <Field label="Your role"><Select value={f.supplier_role} onChange={(e) => setF({ ...f, supplier_role: e.target.value })} placeholder="Choose" options={roles} /></Field>
        <Field label="Brand / OEM"><Input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} /></Field>
        <Field label="Region served"><Input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} placeholder="West, South, All India…" /></Field>
      </div>
      <div><Button variant="deep" icon={<Plus />} loading={add.busy} disabled={!f.category} onClick={add.fire}>Add capability</Button></div>
    </div>
  );
}

export function CapabilityTable({ rows, onRemoved }: { rows: any[]; onRemoved?: () => void }) {
  const del = useAction((id: number) => api.del(`/vendors/me/capabilities/${id}`), { success: 'Proposal withdrawn', invalidate: [['vendor-onboarding'], ['vendor-profile']], onSuccess: onRemoved });
  if (!rows.length) return <p className="small muted" style={{ margin: 0 }}>Nothing proposed yet.</p>;
  return (
    <div className="tbl-wrap">
      <table className="tbl tbl--dense">
        <thead><tr><th>Category</th><th>Sub-category</th><th>Role</th><th>Brand</th><th>Region</th><th>Status</th><th /></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>{c.category} <span className="small muted">{c.category_name}</span></td><td>{c.sub_category ?? '—'}</td><td>{c.supplier_role ?? '—'}</td><td>{c.brand ?? '—'}</td><td>{c.region ?? '—'}</td>
              <td><Status value={c.status} />{c.decision_note && <div className="small muted">{c.decision_note}</div>}</td>
              <td>{c.status === 'Proposed' && <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => del.fire(c.id)}>Withdraw {c.category}</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Capabilities({ o }: { o: any }) {
  return (
    <Card title="What you supply" actions={<span className="small muted">Procurement approves each row before it is used for RFQ suggestions (FR-VPT-13)</span>}>
      <div className="stack">
        <CapabilityTable rows={o.capabilities} />
        {o.editable && <CapabilityForm categories={o.categories} roles={o.supplier_roles} />}
      </div>
    </Card>
  );
}

function Submit({ o }: { o: any }) {
  const [open, setOpen] = useState(false);
  const submit = useAction(() => api.post('/vendors/me/onboarding/submit'), { success: o.vendor.onboarding_status === 'Clarification requested' ? 'Application resubmitted' : 'Application submitted to Equipcare', invalidate: [['vendor-onboarding'], ['me']], silentError: true, onSuccess: () => setOpen(false) });
  const missing = o.checklist.filter((c: any) => !c.ok);
  return (
    <Card title="Review and submit">
      <div className="stack">
        <ul className="list-plain stack-sm">
          {o.checklist.map((c: any) => (
            <li key={c.key} className="row">{c.ok ? <CheckCircle2 size={16} color="var(--ok)" aria-hidden /> : <Circle size={16} color="var(--warn)" aria-hidden />}<span style={{ fontWeight: c.ok ? 500 : 700 }}>{c.label}</span>{!c.ok && <span className="small muted">— {c.hint}</span>}</li>
          ))}
        </ul>
        <Callout tone="info">Once submitted you cannot edit the application unless Equipcare asks for a clarification. You will be notified at every step.{o.submitted_at ? ` Last submitted ${fmtDate(o.submitted_at)}.` : ''}</Callout>
        <ErrorSummary error={submit.error} />
        {o.editable ? <div><Button variant="primary" icon={<Send />} disabled={missing.length > 0} onClick={() => setOpen(true)}>{o.vendor.onboarding_status === 'Clarification requested' ? 'Resubmit application' : 'Submit application'}</Button>{missing.length > 0 && <span className="small muted" style={{ marginLeft: 10 }}>Complete {missing.length} item(s) first.</span>}</div> : <Badge tone="info">Submitted</Badge>}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Submit your application?" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={submit.busy} onClick={submit.fire}>Submit application</Button></>}>
        <p>Equipcare procurement and finance will review your details and documents. Please confirm that the GSTIN, PAN, bank details and documents are correct.</p>
      </Modal>
    </Card>
  );
}
