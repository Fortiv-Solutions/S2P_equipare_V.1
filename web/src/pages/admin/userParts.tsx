/** User-administration pieces shared by Users & roles and the vendor 360 portal-user tab. */
import { useState } from 'react';
import { Copy, KeyRound, Lock, LockOpen, UserX, UserCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { Button, Callout, SimBadge } from '@/components/ui';
import { ConfirmDialog, Modal, ReasonDialog, useToast } from '@/components/overlay';

export interface AdminUser {
  id: number; name: string; email: string; phone: string | null; roles: string; role_list?: string[]; department: string | null; plant_scope: string | null;
  categories: string | null; title: string | null; vendor_id: number | null; vendor_role: string | null; vendor_name?: string | null; vendor_sap_code?: string | null;
  active: number; locked: number; failed_attempts: number; manager_id: number | null; manager_name?: string | null; last_login: string | null; created_at: string | null;
  sessions?: number; sod?: { roles: string[]; risk: string }[];
}

export const userState = (u: Pick<AdminUser, 'active' | 'locked'>) => (!u.active ? 'Deactivated' : u.locked ? 'Locked' : 'Active');

/** Shows a temporary password exactly once. */
export function TempPasswordModal({ value, onClose, who }: { value: { temporary_password: string; delivery?: string } | null; onClose: () => void; who: string }) {
  const toast = useToast();
  return (
    <Modal open={!!value} onClose={onClose} title={`Temporary password for ${who}`} footer={<Button variant="deep" onClick={onClose}>I have noted it</Button>}>
      <div className="stack">
        <Callout tone="warn" title="Shown once">Give this password to the user through a trusted channel. It is not stored in readable form and cannot be shown again.</Callout>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <code className="mono" style={{ fontSize: 'var(--fs-18)', letterSpacing: '0.06em', padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface-sunk)' }}>{value?.temporary_password}</code>
          <Button size="sm" icon={<Copy />} onClick={() => navigator.clipboard?.writeText(value?.temporary_password ?? '').then(() => toast('Password copied'), () => toast('Copy failed — select and copy it', 'warn'))}>Copy</Button>
        </div>
        <div className="sim-panel small"><SimBadge>Simulated outbox</SimBadge> {value?.delivery ?? 'The e-mail notice is recorded in the simulated outbox and was not sent.'}</div>
      </div>
    </Modal>
  );
}

/** Lock / unlock / deactivate / reactivate / reset password for one user (adm.users). */
export function UserActions({ u, invalidate, compact }: { u: AdminUser; invalidate: unknown[][]; compact?: boolean }) {
  const [dlg, setDlg] = useState<'lock' | 'deactivate' | 'reactivate' | 'reset' | 'unlock' | null>(null);
  const [pw, setPw] = useState<{ temporary_password: string; delivery?: string } | null>(null);
  const call = useAction((path: string, body?: unknown) => api.post(`/admin/users/${u.id}/${path}`, body ?? {}), { invalidate });
  const toast = useToast();
  const size = 'sm' as const;
  const B = ({ label, ...rest }: { label: string; variant?: 'primary' | 'ghost'; icon: React.ReactNode; onClick: () => void }) => (
    <Button size={size} variant={rest.variant ?? 'ghost'} icon={rest.icon} iconOnly={compact} title={label} onClick={rest.onClick}>{label}</Button>
  );
  return (
    <div className="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
      {u.active ? (
        <>
          {u.locked || u.failed_attempts > 0
            ? <B variant={u.locked ? 'primary' : 'ghost'} icon={<LockOpen />} onClick={() => setDlg('unlock')} label={u.locked ? 'Unlock' : 'Reset attempts'} />
            : <B icon={<Lock />} onClick={() => setDlg('lock')} label="Lock" />}
          <B icon={<KeyRound />} onClick={() => setDlg('reset')} label="Reset password" />
          <B icon={<UserX />} onClick={() => setDlg('deactivate')} label="Deactivate" />
        </>
      ) : <B icon={<UserCheck />} onClick={() => setDlg('reactivate')} label="Reactivate" />}
      <ReasonDialog open={dlg === 'lock'} onClose={() => setDlg(null)} title={`Lock ${u.name}`} sub="Signs the user out everywhere and blocks sign-in until unlocked." confirmLabel="Lock account" variant="danger"
        onSubmit={async (r) => { await call.run('lock', { reason: r }); toast(`${u.name} locked`); }} />
      <ReasonDialog open={dlg === 'unlock'} onClose={() => setDlg(null)} title={`Unlock ${u.name}`} sub={`Clears ${u.failed_attempts} failed sign-in attempt(s). Recorded in the audit trail (AC-VPT-01).`} confirmLabel="Unlock account" minLength={0} label="Note (optional)"
        onSubmit={async (r) => { await call.run('unlock', { reason: r || null }); toast(`${u.name} unlocked`); }} />
      <ReasonDialog open={dlg === 'deactivate'} onClose={() => setDlg(null)} title={`Deactivate ${u.name}`} sub="The user is signed out everywhere and can no longer sign in. History is kept." confirmLabel="Deactivate user" variant="danger"
        onSubmit={async (r) => { await call.run('deactivate', { reason: r }); toast(`${u.name} deactivated`); }} />
      <ReasonDialog open={dlg === 'reactivate'} onClose={() => setDlg(null)} title={`Reactivate ${u.name}`} confirmLabel="Reactivate user"
        onSubmit={async (r) => { await call.run('reactivate', { reason: r }); toast(`${u.name} reactivated`); }} />
      <ConfirmDialog open={dlg === 'reset'} onClose={() => setDlg(null)} title={`Reset password for ${u.name}?`} confirmLabel="Reset password" variant="deep"
        onConfirm={async () => { const r = await call.run('reset-password') as { temporary_password: string; delivery: string }; setPw(r); toast(`Password reset for ${u.name}`); }}>
        <p>A temporary password is generated and shown once. The user is signed out everywhere.</p>
      </ConfirmDialog>
      <TempPasswordModal value={pw} onClose={() => setPw(null)} who={u.name} />
    </div>
  );
}
