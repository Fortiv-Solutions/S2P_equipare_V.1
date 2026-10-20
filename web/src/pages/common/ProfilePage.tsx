import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { Badge, Button, Card, KV, PageHeader, SimBadge } from '@/components/ui';
import { Field, Input, Select, ErrorSummary, fieldError } from '@/components/forms';

const EVENTS: [string, string][] = [
  ['NTF-01', 'PR line assigned'], ['NTF-02', 'PR ageing alert'], ['NTF-03', 'PR clarification'], ['NTF-04', 'RFQ invitation'], ['NTF-05', 'RFQ closing reminder'],
  ['NTF-07', 'RFQ closed'], ['NTF-08', 'Quotation received'], ['NTF-10', 'Approval request'], ['NTF-11', 'Approval reminder / escalation'], ['NTF-12', 'Approval decision'],
  ['NTF-13', 'Contract expiry'], ['NTF-14', 'Off-contract alert'], ['NTF-16', 'PO published'], ['NTF-17', 'Acknowledgement pending'], ['NTF-18', 'Dispatch / delivery reminder'],
  ['NTF-19', 'Delay escalation'], ['NTF-20', 'PO amended'], ['NTF-21', 'ASN submitted'], ['NTF-22', 'Dispute raised / assigned'], ['NTF-23', 'Dispute ageing'],
  ['NTF-25', 'KYC document expiry'], ['NTF-26', 'Ticket update'], ['NTF-27', 'Invoice received'], ['NTF-28', 'Invoice exception'], ['NTF-30', 'Payment released'],
  ['NTF-31', 'Advance ageing'], ['NTF-32', 'Integration failure'],
];

export default function ProfilePage() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const prefs = useQuery<{ prefs: Record<string, string>; mandatory: string[]; channels: Record<string, boolean> }>({ queryKey: ['prefs'], queryFn: () => api.get('/me/preferences') });
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => { if (prefs.data) setDraft(prefs.data.prefs); }, [prefs.data]);
  const save = useAction(() => api.put('/me/preferences', { prefs: draft }), { success: 'Preferences saved', invalidate: [['prefs']] });
  const [pw, setPw] = useState({ current: '', next: '' });
  const change = useAction(() => api.post('/auth/password', pw), { success: 'Password changed — sign in again', onSuccess: async () => { await logout(); navigate('/login'); } });
  if (!me) return null;
  return (
    <>
      <PageHeader title="Profile & preferences" screen="SCR-PLT-04" />
      <div className="split">
        <div className="stack">
          <Card title="Notification preferences" actions={<Button variant="deep" size="sm" loading={save.busy} onClick={save.fire}>Save preferences</Button>}>
            <p className="small muted" style={{ marginBottom: 12 }}>
              In-app notifications always arrive. E-mail copies <SimBadge>Simulated outbox</SimBadge> are recorded but not sent. Mandatory events cannot be switched off.
            </p>
            <div className="tbl-wrap">
              <table className="tbl tbl--dense">
                <thead><tr><th>Event</th><th>Delivery</th></tr></thead>
                <tbody>
                  {EVENTS.map(([id, label]) => {
                    const mandatory = prefs.data?.mandatory.includes(id);
                    return (
                      <tr key={id}>
                        <td><span className="mono small subtle">{id}</span> {label} {mandatory && <Badge plain tone="info">Mandatory</Badge>}</td>
                        <td style={{ width: 240 }}>
                          <Select className="select--sm" aria-label={`Delivery for ${label}`} disabled={mandatory} value={draft[id] ?? 'immediate'} onChange={(e) => setDraft({ ...draft, [id]: e.target.value })}
                            options={[{ value: 'immediate', label: 'Immediate (in-app + e-mail)' }, { value: 'digest', label: 'Daily digest' }, { value: 'in_app_only', label: 'In-app only' }]} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <div className="stack">
          <Card title="Your account">
            <KV items={[['Name', me.name], ['E-mail', me.email], ['Role', me.roleLabel], ['All roles', me.roles.map((r) => r.label).join(', ')], ['Title', me.title], ['Plants', me.plants === '*' ? 'All plants' : me.plants.join(', ')], ...(me.vendor ? [['Vendor', me.vendor.name] as [string, string]] : [])]} />
          </Card>
          {me.singleUser ? (
            <Card title="Sign-in"><p className="small muted">Single-user mode: there is no password or sign-in. The app always opens as the Administrator.</p></Card>
          ) : (
          <Card title="Change password">
              <form className="stack" onSubmit={(e) => { e.preventDefault(); change.fire(); }}>
                <ErrorSummary error={change.error} />
                <Field label="Current password" required error={fieldError(change.error, 'current')}><Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
                <Field label="New password" required hint="At least 10 characters with a letter and a number. You will be signed out everywhere." error={fieldError(change.error, 'next')}>
                  <Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
                </Field>
                <Button type="submit" variant="deep" loading={change.busy} disabled={!pw.current || pw.next.length < 10}>Change password</Button>
              </form>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
