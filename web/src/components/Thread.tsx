/** Clarification / comment thread on any record. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, fmtDateTime } from '@/lib/format';
import { Avatar, Button, Empty } from './ui';
import { Textarea } from './forms';
import { useToast } from './overlay';

export interface ThreadMessage { id: number; body: string; created_at: string; user_id: number; user_name: string; internal?: number }

export function ThreadView({ messages, onSend, placeholder, sendLabel = 'Send', disabled, note }: { messages: ThreadMessage[]; onSend?: (body: string) => Promise<unknown>; placeholder?: string; sendLabel?: string; disabled?: boolean; note?: string }) {
  const { me } = useAuth();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <div className="stack">
      {messages.length === 0 ? <Empty title="No messages yet">{onSend ? 'Start the conversation below.' : undefined}</Empty> : (
        <div className="thread">
          {messages.map((m) => (
            <div key={m.id} className="msg" data-mine={m.user_id === me?.id}>
              <Avatar name={m.user_name} size="sm" />
              <div style={{ minWidth: 0 }}>
                <div className="msg__meta" title={fmtDateTime(m.created_at)}>{m.user_name} · {ago(m.created_at)}{m.internal === 1 ? ' · internal' : ''}</div>
                <div className="msg__bubble" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {onSend && !disabled && (
        <div className="stack-sm">
          <Textarea aria-label="Message" placeholder={placeholder ?? 'Write a message…'} value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={2000} />
          <div className="row between">
            <span className="small subtle">{note}</span>
            <Button variant="deep" size="sm" icon={<Send />} loading={busy} disabled={body.trim().length < 3} onClick={async () => {
              setBusy(true);
              try { await onSend(body.trim()); setBody(''); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
            }}>{sendLabel}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Generic thread backed by /api/comments. */
export function CommentThread({ objectType, objectId, canPost = true, internalDefault = true }: { objectType: string; objectId: number; canPost?: boolean; internalDefault?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery<ThreadMessage[]>({ queryKey: ['comments', objectType, objectId], queryFn: () => api.get('/comments', { object_type: objectType, object_id: objectId }) });
  return (
    <ThreadView
      messages={q.data ?? []}
      onSend={canPost ? async (body) => { await api.post('/comments', { object_type: objectType, object_id: objectId, body, internal: internalDefault }); await qc.invalidateQueries({ queryKey: ['comments', objectType, objectId] }); } : undefined}
      note={internalDefault ? 'Internal — not visible to vendors.' : undefined}
    />
  );
}
