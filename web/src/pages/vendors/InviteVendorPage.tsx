import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Copy, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Button, ButtonLink, Callout, Card, PageHeader, SimBadge } from '@/components/ui';
import { ErrorSummary, Field, Input, Select, fieldError } from '@/components/forms';
import { useToast } from '@/components/overlay';

export default function InviteVendorPage() {
  const meta = useQuery<{ categories: { code: string; name: string }[]; invite_valid_days: number }>({ queryKey: ['vendors', 'meta'], queryFn: () => api.get('/vendors/meta') });
  const [f, setF] = useState({ legal_name: '', contact_name: '', email: '', phone: '', category: '' });
  const [done, setDone] = useState<{ id: number; link: string; expires_at: string } | null>(null);
  const toast = useToast();
  const invite = useAction(() => api.post<{ id: number; link: string; expires_at: string }>('/vendors/invite', f), {
    success: () => `Invitation created for ${f.legal_name}`, invalidate: [['vendors']], onSuccess: setDone, silentError: true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const url = done ? `${window.location.origin}${done.link}` : '';
  return (
    <>
      <PageHeader eyebrow={<><Link to="/vendors">Vendors</Link><span>/</span><span>Invite</span></>} screen="WF-06" title="Invite a new vendor"
        sub="Existing SAP vendors get portal users from their vendor record. New vendors register from an invitation, then go through KYC review, approval and SAP vendor creation." />
      <div className="split">
        {!done ? (
          <Card title="Vendor and contact">
            <form className="stack" onSubmit={(e) => { e.preventDefault(); invite.fire(); }}>
              <ErrorSummary error={invite.error} />
              <div className="form-grid">
                <Field label="Legal name" required className="span-2" error={fieldError(invite.error, 'legal_name')}><Input value={f.legal_name} onChange={set('legal_name')} maxLength={120} placeholder="As on the GST certificate" /></Field>
                <Field label="Contact person" required error={fieldError(invite.error, 'contact_name')}><Input value={f.contact_name} onChange={set('contact_name')} maxLength={80} /></Field>
                <Field label="Contact e-mail" required hint="The registration link is sent here and becomes the vendor administrator's sign-in." error={fieldError(invite.error, 'email')}><Input type="email" value={f.email} onChange={set('email')} /></Field>
                <Field label="Mobile" error={fieldError(invite.error, 'phone')}><Input value={f.phone} onChange={set('phone')} placeholder="+91 98xxx xxxxx" /></Field>
                <Field label="Spend category" required error={fieldError(invite.error, 'category')}>
                  <Select value={f.category} onChange={set('category')} placeholder="Choose a category" options={(meta.data?.categories ?? []).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))} />
                </Field>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <ButtonLink to="/vendors">Cancel</ButtonLink>
                <Button type="submit" variant="primary" icon={<Send />} loading={invite.busy} disabled={!f.legal_name || !f.contact_name || !f.email || !f.category}>Create invitation</Button>
              </div>
            </form>
          </Card>
        ) : (
          <Card title="Invitation created">
            <div className="stack">
              <Callout tone="ok" title={`${f.legal_name} is now Invited`}>The link is valid until {fmtDateTime(done.expires_at)} and can be used once.</Callout>
              <div className="sim-panel stack-sm">
                <div className="row-wrap"><SimBadge>E-mail not sent — simulated outbox</SimBadge></div>
                <span className="small">No e-mail provider is connected. The invitation e-mail to <strong>{f.email}</strong> is recorded in the simulated outbox. Share this registration link with the vendor yourself:</span>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <code className="mono small" style={{ wordBreak: 'break-all', background: '#fff', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--line)', flex: '1 1 260px' }}>{url}</code>
                  <Button size="sm" icon={<Copy />} onClick={() => { navigator.clipboard?.writeText(url).then(() => toast('Registration link copied'), () => toast('Copy failed — select the link and copy it', 'warn')); }}>Copy link</Button>
                </div>
              </div>
              <div className="row-wrap">
                <ButtonLink to={`/vendors/${done.id}`} variant="deep">Open vendor record</ButtonLink>
                <Button onClick={() => { setDone(null); setF({ legal_name: '', contact_name: '', email: '', phone: '', category: '' }); }}>Invite another vendor</Button>
              </div>
            </div>
          </Card>
        )}
        <Card title="What happens next">
          <ol className="timeline">
            {[
              ['Vendor registers', 'Sets a password from the link and signs in with a one-time code.'],
              ['Vendor completes onboarding', 'Company, GSTIN/PAN, MSME, bank, contacts, documents and capabilities.'],
              ['Procurement and finance review', 'Documents and capabilities (procurement), bank and KYC (finance).'],
              ['Approval', 'Vendor onboarding approval: Procurement Manager, then Finance.'],
              ['SAP vendor creation', 'SAP team creates the vendor; the code links on the next vendor sync.'],
            ].map(([t, b]) => <li key={t}><span className="timeline__dot" /><div className="timeline__title">{t}</div><div className="timeline__meta">{b}</div></li>)}
          </ol>
          <p className="small muted" style={{ marginTop: 10 }}>Links stay valid for {meta.data?.invite_valid_days ?? '—'} days (configurable, DEC-08).</p>
        </Card>
      </div>
    </>
  );
}
