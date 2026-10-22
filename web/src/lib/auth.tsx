import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';

export type RoleCode = 'REQ' | 'BUY' | 'APR' | 'VEN' | 'STO' | 'FIN' | 'SAP' | 'MGT' | 'ADM';

export interface Me {
  id: number;
  name: string;
  email: string;
  title: string | null;
  department: string | null;
  phone: string | null;
  role: RoleCode;
  roleLabel: string;
  roles: { code: RoleCode; label: string }[];
  perms: string[];
  plants: string[] | '*';
  categories: string[];
  vendor: { id: number; name: string; sap_code: string | null; onboarding_status: string; portal_status: string } | null;
  vendorRole: string | null;
  /** Single-user mode: no sign-in; one Administrator account holds every internal module. */
  singleUser: boolean;
  merged: boolean;
  actingVendor: { id: number; name: string } | null;
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  can: (...perms: string[]) => boolean;
  isVendor: boolean;
  refresh: () => Promise<unknown>;
  switchRole: (role: RoleCode) => Promise<void>;
  logout: () => Promise<void>;
  /** Single-user mode: open the vendor portal as one vendor company. */
  actAsVendor: (vendorId: number) => Promise<void>;
  /** Single-user mode: leave the vendor portal and return to the administrator workspace. */
  exitVendor: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export const DEFAULT_ADMIN: Me = {
  id: 1,
  name: 'Administrator',
  email: 'admin@equipcare.test',
  title: 'Administrator — all modules',
  department: 'Procurement, Finance, Stores, IT',
  phone: null,
  role: 'ADM',
  roleLabel: 'Administrator — all modules',
  roles: [{ code: 'ADM', label: 'Administrator — all modules' }],
  perms: [
    'pr.view_own', 'pr.view', 'pr.work', 'pr.assign', 'pr.clarify',
    'rfq.view', 'rfq.manage', 'rfq.vendor', 'qtn.submit', 'qtn.view',
    'cmp.view', 'cmp.manage', 'apr.decide', 'apr.view', 'exc.view',
    'con.view', 'con.manage', 'con.vendor',
    'po.view', 'po.view_own_pr', 'po.followup', 'po.amend', 'po.vendor',
    'asn.view', 'asn.vendor', 'asn.receive', 'dsp.view', 'dsp.raise', 'dsp.manage', 'dsp.vendor', 'dsp.hold',
    'inv.view', 'inv.vendor', 'inv.review', 'inv.upload_behalf', 'inv.comment',
    'pay.view', 'pay.vendor', 'adv.request', 'adv.manage',
    'vendor.view', 'vendor.onboard', 'vendor.review_kyc', 'vendor.review_bank', 'vendor.self', 'vendor.users',
    'tkt.raise', 'tkt.handle',
    'rpt.view', 'rpt.finance', 'rpt.stores', 'rpt.integration', 'rpt.export',
    'sap.monitor', 'sap.replay', 'sapsim.po', 'sapsim.grn', 'sapsim.fin', 'sapsim.all',
    'adm.users', 'adm.config', 'adm.masters', 'audit.view', 'audit.view_all', 'config.approve_tolerance',
  ],
  plants: '*',
  categories: ['CAPEX', 'MECH', 'ELEC', 'CHEM', 'CIVIL', 'SAFETY', 'LOGIS', 'IT', 'SERVICES'],
  vendor: null,
  vendorRole: null,
  singleUser: true,
  merged: true,
  actingVendor: null,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return DEFAULT_ADMIN;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    const onUnauth = () => qc.setQueryData(['me'], DEFAULT_ADMIN);
    // The workspace (administrator / vendor portal) is per browser, so a tab can be left behind by another tab.
    // Re-read who we are; RequireAuth then moves this tab to the matching workspace.
    let last = 0;
    const onWorkspace = () => {
      if (Date.now() - last < 1500) return;
      last = Date.now();
      qc.clear();
      void qc.invalidateQueries();
    };
    window.addEventListener('s2p:unauthenticated', onUnauth);
    window.addEventListener('s2p:workspace-changed', onWorkspace);
    return () => {
      window.removeEventListener('s2p:unauthenticated', onUnauth);
      window.removeEventListener('s2p:workspace-changed', onWorkspace);
    };
  }, [qc]);

  const me = q.data ?? (q.isError ? DEFAULT_ADMIN : null);

  useEffect(() => {
    if (me?.singleUser && me?.role === 'VEN' && me?.vendor && me.vendor.onboarding_status !== 'Active') {
      void api.post('/auth/switch-role', { role: 'ADM' }).then(() => {
        qc.clear();
        void qc.invalidateQueries();
      });
    }
  }, [me, qc]);
  const can = useCallback((...perms: string[]) => !!me && perms.some((p) => me.perms.includes(p)), [me]);

  const switchRole = async (role: RoleCode) => {
    await api.post('/auth/switch-role', { role });
    qc.clear();
    await qc.invalidateQueries();
  };
  const actAsVendor = async (vendorId: number) => {
    await api.post('/auth/switch-role', { role: 'VEN', vendor_id: vendorId });
    qc.clear();
    await qc.invalidateQueries();
  };
  const exitVendor = async () => {
    await api.post('/auth/switch-role', { role: 'ADM' });
    qc.clear();
    await qc.invalidateQueries();
  };
  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    qc.setQueryData(['me'], DEFAULT_ADMIN);
  };

  return (
    <Ctx.Provider value={{ me, loading: q.isLoading, can, isVendor: me?.role === 'VEN', refresh: () => q.refetch(), switchRole, logout, actAsVendor, exitVendor }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

export interface Meta {
  now: string;
  roles: Record<RoleCode, string>;
  sapOffline: boolean;
  freshness: { id: string; name: string; lastSuccess: string | null; stale: boolean; thresholdMinutes: number; ageMinutes: number | null }[];
  lists: {
    delayReasons: string[];
    disputeTypes: string[];
    ticketCategories: string[];
    routes: string[];
    priorities: string[];
    urgencyTypes: string[];
    gstRates: number[];
  };
  channels: { email: boolean; sms: boolean; whatsapp: boolean; push: boolean };
  sealed: boolean;
}

/** Platform metadata: lists, SAP freshness, simulator outage flag. Refreshes every minute. */
export function useMeta() {
  const { me } = useAuth();
  return useQuery<Meta>({ queryKey: ['meta'], queryFn: () => api.get('/meta'), enabled: !!me, refetchInterval: 60_000, staleTime: 30_000 });
}
