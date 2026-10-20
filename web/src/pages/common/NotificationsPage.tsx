import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Badge, Button, Card, PageHeader } from '@/components/ui';
import { DataTable } from '@/components/DataTable';

interface Notif { id: number; event: string; title: string; body: string | null; link: string | null; severity: string; read_at: string | null; created_at: string }

export default function NotificationsPage() {
  const q = useQuery<{ items: Notif[]; unread: number }>({ queryKey: ['notifications'], queryFn: () => api.get('/notifications') });
  const qc = useQueryClient();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Notifications" screen="SCR-PLT-02" sub="In-app notifications are live. E-mail copies go to a simulated outbox because no e-mail provider is connected."
        actions={<Button icon={<CheckCheck />} disabled={!q.data?.unread} onClick={async () => { await api.post('/notifications/read-all'); qc.invalidateQueries({ queryKey: ['notifications'] }); }}>Mark all read</Button>} />
      <Card flush>
        <DataTable
          id="notifications" rows={q.data?.items} loading={q.isLoading} error={q.error} refetch={q.refetch} rowKey={(r) => r.id}
          onRowClick={async (r) => { if (!r.read_at) await api.post(`/notifications/${r.id}/read`); qc.invalidateQueries({ queryKey: ['notifications'] }); if (r.link) navigate(r.link); }}
          filters={[{ key: 'event', label: 'Event', value: (r) => r.event }, { key: 'read', label: 'State', value: (r) => (r.read_at ? 'Read' : 'Unread') }]}
          columns={[
            { key: 'title', header: 'Notification', render: (r) => <span style={{ fontWeight: r.read_at ? 500 : 700 }}>{r.title}</span> },
            { key: 'body', header: 'Detail', render: (r) => <span className="muted">{r.body}</span> },
            { key: 'event', header: 'Event', render: (r) => <span className="mono small">{r.event}</span> },
            { key: 'severity', header: 'Type', render: (r) => <Badge tone={r.severity === 'danger' ? 'bad' : r.severity === 'warning' ? 'warn' : r.severity === 'success' ? 'ok' : 'info'}>{r.severity}</Badge> },
            { key: 'created_at', header: 'When', render: (r) => fmtDateTime(r.created_at), nowrap: true },
          ]}
          initialSort={{ key: 'created_at', dir: 'desc' }}
          mobile={{ title: (r) => r.title, badge: (r) => (!r.read_at ? <Badge tone="amber">New</Badge> : undefined), meta: (r) => [r.event, fmtDateTime(r.created_at)] }}
        />
      </Card>
    </>
  );
}
