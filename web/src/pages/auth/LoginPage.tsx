import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Avatar, Button, SimBadge, Badge } from '@/components/ui';
import { Field, Input, ErrorSummary } from '@/components/forms';
import { TrackChain, chainFrom } from '@/components/TrackChain';

interface Persona { id: number; name: string; email: string; title: string; vendor: string | null; roles: { code: string; label: string }[] }

const DEMO_PASSWORD = 'Equipcare@2026';

export function LoginPage() {
  const navigate = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [mfa, setMfa] = useState<{ code: string; delivery: string } | null>(null);
  const [otp, setOtp] = useState('');
  const personas = useQuery<Persona[]>({ queryKey: ['demo-users'], queryFn: () => api.get('/auth/demo-users') });
  const next = (loc.state as { from?: string } | null)?.from ?? '/';

  const finish = async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    const me = await qc.fetchQuery({ queryKey: ['me'], queryFn: () => api.get('/auth/me') });
    navigate(me?.role === 'VEN' ? (next.startsWith('/vendor') ? next : '/vendor') : next === '/login' ? '/' : next, { replace: true });
  };

  const signIn = async (e?: string, p?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok?: boolean; mfaRequired?: boolean; simulatedCode?: string; delivery?: string }>('/auth/login', { email: e ?? email, password: p ?? password });
      if (r.mfaRequired) {
        setMfa({ code: r.simulatedCode!, delivery: r.delivery! });
        setOtp('');
      } else await finish();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/verify-otp', { code: otp });
      await finish();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const internal = personas.data?.filter((p) => !p.vendor) ?? [];
  const vendors = personas.data?.filter((p) => p.vendor) ?? [];

  return (
    <div className="auth">
      <section className="auth__hero">
        <img src="/brand/logo-white.svg" alt="Equipcare" style={{ height: 54, width: 'auto', alignSelf: 'flex-start' }} />
        <div className="stack" style={{ gap: 28 }}>
          <h1>Keep the fleet moving. <em>Know who owns the next step.</em></h1>
          <p style={{ maxWidth: 520, color: '#b8c9dc', fontSize: 'var(--fs-16)' }}>
            One workflow from open PR to payment for Equipcare's buyers, stores, finance and vendors. SAP stays the system of record.
          </p>
          <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '14px 10px 8px', maxWidth: 640 }}>
            <TrackChain compact dark label="Source-to-pay stages" steps={chainFrom(['PR', 'Route', 'RFQ', 'Compare', 'Approve', 'PO', 'ASN', 'GRN', 'Invoice', 'Pay'], 5)} />
          </div>
        </div>
        <p className="small" style={{ color: '#7f97b3' }}>Knowteq Equipcare LLP · Source-to-Pay MVP built by Fortiv Solutions · demo data only</p>
      </section>

      <section className="auth__form">
        <div className="stack-sm">
          <h2 style={{ fontSize: 'var(--fs-24)' }}>{mfa ? 'Enter your sign-in code' : 'Sign in'}</h2>
          <p className="muted">{mfa ? 'Vendors confirm each sign-in with a one-time code.' : 'Use your Equipcare or vendor portal account.'}</p>
        </div>
        <ErrorSummary error={error instanceof ApiError ? error : error ? new ApiError(0, 'x', 'Sign-in failed.') : null} />

        {mfa ? (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); verify(); }}>
            <div className="sim-panel stack-sm">
              <SimBadge>Simulated delivery</SimBadge>
              <span className="small">{mfa.delivery}</span>
              <span>Your code: <strong className="mono" style={{ fontSize: 'var(--fs-18)', letterSpacing: '0.12em' }}>{mfa.code}</strong></span>
            </div>
            <Field label="6-digit code" required>
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} autoFocus />
            </Field>
            <Button type="submit" variant="primary" size="lg" icon={<ShieldCheck />} loading={busy} disabled={otp.length !== 6}>Verify and continue</Button>
            <Button variant="ghost" onClick={() => { setMfa(null); setError(null); }}>Use a different account</Button>
          </form>
        ) : (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); signIn(); }}>
            <Field label="E-mail" required><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Password" required><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <Button type="submit" variant="primary" size="lg" icon={<LogIn />} loading={busy} disabled={!email || !password}>Sign in</Button>
            <Button variant="secondary" disabled title="Equipcare SSO is not configured yet (DEC-12)" icon={<KeyRound />}>Sign in with Equipcare SSO — not configured (DEC-12)</Button>
          </form>
        )}

        {!mfa && !!personas.data?.length && (
          <div className="stack-sm">
            <div className="row between">
              <h3>Demo accounts</h3>
              <span className="small muted">Password <span className="mono">{DEMO_PASSWORD}</span></span>
            </div>
            <p className="small muted">Pick a persona to sign in as that role. All people and companies are fictional.</p>
            <div className="grid-2" style={{ gap: 8 }}>
              {[...internal, ...vendors].map((p) => (
                <button key={p.id} className="persona" disabled={busy} onClick={() => { setEmail(p.email); setPassword(DEMO_PASSWORD); signIn(p.email, DEMO_PASSWORD); }}>
                  <Avatar name={p.name} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600 }}>{p.name}</span>
                    <span className="small muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.vendor ?? p.title}</span>
                  </span>
                  <span className="row" style={{ gap: 4 }}>
                    {p.roles.map((r) => <Badge key={r.code} plain tone={r.code === 'VEN' ? 'amber' : r.code === 'APR' ? 'decision' : 'info'}>{r.code}</Badge>)}
                    <ArrowRight size={14} aria-hidden />
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
