import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import type { Workspace, WorkspaceTab } from '@/nav';

/**
 * Tab strip shown under the top bar inside a workspace (Sourcing, Delivery, Finance). The sidebar has one entry per
 * workspace; this is how the module screens stay one click away without fifteen sidebar entries.
 */
export function WorkspaceTabs({ workspace, active, counts }: { workspace: Workspace; active: WorkspaceTab; counts?: Record<string, number> }) {
  const { can } = useAuth();
  const tabs = workspace.tabs.filter((t) => !t.perms || can(...t.perms));
  return (
    <nav className="wstabs no-print" aria-label={`${workspace.label} sections`}>
      <span className="wstabs__name"><workspace.icon aria-hidden />{workspace.label}</span>
      <div className="wstabs__list">
        {tabs.map((t) => {
          const n = t.count ? counts?.[t.count] : undefined;
          return (
            <Link key={t.to} to={t.to} className="wstabs__tab" aria-current={t.to === active.to ? 'page' : undefined}>
              {t.label}
              {!!n && <span className="wstabs__count" aria-label={`${n} need attention`}>{n > 99 ? '99+' : n}</span>}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
