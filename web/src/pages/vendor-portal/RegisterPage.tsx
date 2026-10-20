/** Public: accept a vendor invitation by setting a password (FR-VPT-11, WF-06). */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, LogIn } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Button, Callout, ErrorState, LoadingBlock } from '@/components/ui';
import { ErrorSummary, Field, Input, fieldError } from '@/components/forms';
import { TrackChain, chainFrom } from '@/components/TrackChain';

export default function RegisterPage() {
  const token = useSearchParams()[0].get('token') ?? '';
  const navigate = useNavigate();
  const info = useQuery<{ vendor: string; contact_name: string; email: string; expires_at: string; expired: boolean; status: string; single_user?: boolean }>({
    queryKey: ['register', token], queryFn: () => api.get(`/vendors/register/${encodeURIComponent(token)}`), enabled: !!token, retry: false,
  });
  const [f, setF] = useState({ name: '', phone: '', password: '', confirm: '' });
  const [done, setDone] = useState(false);
  const reg = useAction(() => api.post('/vendors/register', { token, ...f, phone: f.phone || undefined }), { onSuccess: () => setDone(true), silentError: true });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const mismatch = f.confirm.length > 0 && f.password !== f.confirm;
  const v = info.data;
  const single = !!v?.single_user;
  return (
    <div className="auth">
      <section className="auth__hero">
        <img src="/brand/logo-white.svg" alt="Equipcare" style={{ height: 54, width: 'auto', alignSelf: 'flex-start' }} />
        <div className="stack" style={{ gap: 28 }}>
          <h1>Join the Equipcare <em>vendor portal.</em></h1>
          <p style={{ maxWidth: 520, color: '#b8c9dc', fontSize: 'var(--fs-16)' }}>Register once, send your KYC documents, and receive RFQs, purchase orders and payment updates in one place.</p>
          <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '14px 10px 8px', maxWidth: 640 }}>
            <TrackChain compact dark label="Onboarding stages" steps={chainFrom(['Invited', 'Register', 'Documents', 'Review', 'Approval', 'SAP code', 'Active'], 1)} />
          </div>
        </div>
        <p className="small" style={{ color: '#7f97b3' }}>Knowteq Equipcare LLP · demo data only</p>
      </section>
      <section className="auth__form">
        {!token ? <Callout tone="bad" title="This link is incomplete">Open the registration link from your invitation e-mail, or ask your Equipcare buyer to send a new one. <Link to="/login">Back to sign in</Link></Callout>
          : info.isLoading ? <LoadingBlock rows={4} />
            : info.error ? <ErrorState error={info.error} />
              : done ? (
                <div className="stack">
                  <h2 style={{ fontSize: 'var(--fs-24)' }}>{single ? 'Registration started' : 'Account created'}</h2>
                  {single ? (
                    <Callout tone="ok" title={`Thank you, ${f.name.split(' ')[0]}`}>Your invitation for {v?.vendor} has been accepted. This installation has no vendor sign-in, so the Equipcare administrator completes your company details and documents with you, in the vendor portal view for {v?.vendor}.</Callout>
                  ) : (
                    <>
                      <Callout tone="ok" title={`Welcome, ${f.name.split(' ')[0]}`}>Sign in with <strong>{v?.email}</strong> and your new password. You will confirm each sign-in with a one-time code, then complete your company details and documents.</Callout>
                      <Button variant="primary" size="lg" icon={<LogIn />} onClick={() => navigate('/login')}>Go to sign in</Button>
                    </>
                  )}
                </div>
              ) : v?.status !== 'Invited' ? (
                <div className="stack"><h2 style={{ fontSize: 'var(--fs-24)' }}>Invitation already used</h2><Callout tone="info">This invitation has already been accepted. <Link to="/login">Sign in</Link> with your e-mail and password.</Callout></div>
              ) : v?.expired ? (
                <div className="stack"><h2 style={{ fontSize: 'var(--fs-24)' }}>Invitation expired</h2><Callout tone="bad" title="This link is no longer valid">It expired on {fmtDate(v.expires_at)}. Ask your Equipcare buyer to send a new invitation.</Callout></div>
              ) : (
                <form className="stack" onSubmit={(e) => { e.preventDefault(); reg.fire(); }}>
                  <div className="stack-sm"><h2 style={{ fontSize: 'var(--fs-24)' }}>Register {v?.vendor}</h2><p className="muted">{single ? 'Confirm your name to accept the invitation.' : 'Set a password to create the vendor administrator account.'} The link works once and expires on {fmtDate(v?.expires_at)}.</p></div>
                  <ErrorSummary error={reg.error} />
                  <Field label={single ? 'Contact e-mail' : 'Sign-in e-mail'}><Input value={v?.email ?? ''} readOnly /></Field>
                  <Field label="Your full name" required error={fieldError(reg.error, 'name')}><Input autoComplete="name" value={f.name || ''} onChange={set('name')} placeholder={v?.contact_name} /></Field>
                  <Field label="Mobile (optional)" error={fieldError(reg.error, 'phone')}><Input autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
                  {!single && (
                    <>
                      <Field label="Password" required hint="At least 10 characters with a letter and a number." error={fieldError(reg.error, 'password')}><Input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} /></Field>
                      <Field label="Confirm password" required error={mismatch ? 'The two passwords do not match.' : fieldError(reg.error, 'confirm')}><Input type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} /></Field>
                    </>
                  )}
                  <Button type="submit" variant="primary" size="lg" icon={<ShieldCheck />} loading={reg.busy} disabled={f.name.trim().length < 2 || (!single && (f.password.length < 10 || f.password !== f.confirm))}>{single ? 'Accept invitation' : 'Create account'}</Button>
                  {!single && <p className="small muted">Already registered? <Link to="/login">Sign in</Link></p>}
                </form>
              )}
      </section>
    </div>
  );
}
