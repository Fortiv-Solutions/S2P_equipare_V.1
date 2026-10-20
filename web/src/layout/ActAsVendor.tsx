import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge, Callout, ErrorState, LoadingBlock } from '@/components/ui';
import { Input } from '@/components/forms';
import { Modal, useToast } from '@/components/overlay';

interface VendorRow { id: number; name: string; sap_code: string | null; city: string | null; state: string | null; onboarding_status: string; portal_status: string }

/**
 * Single-user mode has no vendor accounts, so the Administrator opens the vendor portal as one vendor company.
 * Vendor data isolation is unchanged: while acting, only that vendor's records are visible.
 */
export function ActAsVendorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { actAsVendor } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const list = useQuery<VendorRow[]>({ queryKey: ['acting-vendors'], queryFn: () => api.get('/auth/acting-vendors'), enabled: open, staleTime: 60_000 });
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data ?? []).filter((v) => !needle || `${v.name} ${v.sap_code ?? ''} ${v.city ?? ''}`.toLowerCase().includes(needle));
  }, [list.data, q]);

  const choose = async (v: VendorRow) => {
    setBusy(v.id);
    try {
      await actAsVendor(v.id);
      onClose();
      navigate(v.onboarding_status === 'Active' ? '/vendor' : '/vendor/onboarding');
      toast(`Vendor portal view: ${v.name}`, 'info');
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Open the vendor portal as…" sub="Choose the vendor company whose portal you want to see and work in.">
      <div className="stack">
        <Callout tone="info">
          This installation has one account, so there are no vendor logins. You act for the vendor you choose: you see only that vendor's RFQs, POs, invoices and messages, and every action is recorded against both the vendor and the Administrator.
        </Callout>
        <Input aria-label="Search vendors" placeholder="Search by name, SAP code or city" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus />
        {list.isLoading ? <LoadingBlock rows={5} /> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : rows.length === 0 ? (
          <p className="muted">No vendor matches “{q}”.</p>
        ) : (
          <ul className="list-plain" style={{ maxHeight: 360, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
            {rows.map((v) => (
              <li key={v.id} style={{ borderBottom: '1px solid var(--steel-100)' }}>
                <button className="menu__item" style={{ padding: '10px 12px', gap: 12 }} disabled={busy !== null} onClick={() => choose(v)}>
                  <Building2 size={16} color="var(--primary-600)" aria-hidden />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600 }}>{v.name}</span>
                    <span className="small muted">{v.sap_code ? `SAP ${v.sap_code}` : 'No SAP code yet'}{v.city ? ` · ${v.city}` : ''}</span>
                  </span>
                  {v.onboarding_status !== 'Active' && <Badge tone="warn" plain>{v.onboarding_status}</Badge>}
                  <ChevronRight size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
