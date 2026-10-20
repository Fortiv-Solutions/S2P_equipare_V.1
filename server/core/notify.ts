/**
 * Event-driven notifications (PRD Sec 14). In-app notifications are real. No e-mail, SMS or
 * WhatsApp provider is connected, so external channels are written to a simulated outbox with an
 * explicit "not sent" status — the platform never reports them as delivered.
 */
import { all, get, insert, now } from './db.ts';
import { cfg } from './config.ts';
import type { Role } from './permissions.ts';
import { SINGLE_USER } from './mode.ts';
import { adminId } from './singleuser.ts';

export interface NotifyInput {
  event: string; // NTF-xx
  title: string;
  body?: string;
  link?: string;
  severity?: 'info' | 'success' | 'warning' | 'danger';
  objectType?: string;
  objectId?: number;
  users?: (number | null | undefined)[];
  roles?: Role[];
  vendorId?: number | null; // all active users of a vendor
  plant?: string | null; // limit role recipients to plant scope
  exclude?: number[];
  dedupeKey?: string; // defaults to event:objectType:objectId
  mandatory?: boolean;
}

const SIM_EMAIL = 'Simulated — not sent (no e-mail provider connected)';

export function notify(n: NotifyInput) {
  const ids = new Set<number>();
  for (const u of n.users ?? []) if (u) ids.add(u);
  if (n.roles?.length) {
    const users = all<{ id: number; roles: string; plant_scope: string | null }>(
      'SELECT id, roles, plant_scope FROM users WHERE active = 1 AND vendor_id IS NULL',
    );
    for (const u of users) {
      const roles = u.roles.split(',');
      if (!n.roles.some((r) => roles.includes(r))) continue;
      if (n.plant && u.plant_scope && u.plant_scope !== '*' && !u.plant_scope.split(',').includes(n.plant)) continue;
      ids.add(u.id);
    }
  }
  if (n.vendorId) {
    for (const u of all<{ id: number }>('SELECT id FROM users WHERE vendor_id = ? AND active = 1', n.vendorId)) ids.add(u.id);
    // Single-user mode has no vendor accounts: the Administrator receives it in that vendor's portal inbox.
    if (SINGLE_USER) ids.add(adminId());
  }
  for (const x of n.exclude ?? []) ids.delete(x);

  const dedupeMinutes = cfg<number>('notify.dedupe_minutes');
  const key = n.dedupeKey ?? `${n.event}:${n.objectType ?? ''}:${n.objectId ?? ''}`;
  const since = new Date(Date.now() - dedupeMinutes * 60000).toISOString();
  const channels = cfg<{ email: boolean; sms: boolean; whatsapp: boolean; push: boolean }>('notify.channels');
  const created: number[] = [];

  for (const userId of ids) {
    const dup = get('SELECT id FROM notifications WHERE user_id = ? AND dedupe_key = ? AND created_at > ?', userId, key, since);
    if (dup) continue;
    const id = insert('notifications', {
      user_id: userId, event: n.event, title: n.title, body: n.body ?? null, link: n.link ?? null,
      severity: n.severity ?? 'info', object_type: n.objectType ?? null, object_id: n.objectId ?? null,
      dedupe_key: key, created_at: now(), vendor_id: n.vendorId ?? null,
    });
    created.push(id);
    const user = get<{ email: string; phone: string | null; notif_prefs: Record<string, string> | null }>(
      'SELECT email, phone, notif_prefs_json FROM users WHERE id = ?', userId,
    );
    if (!user) continue;
    const pref = user.notif_prefs?.[n.event];
    const wantsEmail = n.mandatory || pref !== 'in_app_only';
    if (channels.email && wantsEmail && pref !== 'digest') {
      insert('outbox', { notification_id: id, channel: 'email', recipient: user.email, subject: n.title, body: n.body ?? '', template: `${n.event}.v1`, status: SIM_EMAIL, created_at: now() });
    } else if (pref === 'digest') {
      insert('outbox', { notification_id: id, channel: 'email-digest', recipient: user.email, subject: n.title, body: n.body ?? '', template: `${n.event}.v1`, status: 'Queued for daily digest (simulated)', created_at: now() });
    }
    for (const ch of ['sms', 'whatsapp'] as const) {
      if (channels[ch] && user.phone) {
        insert('outbox', { notification_id: id, channel: ch, recipient: user.phone, subject: n.title, body: n.body ?? '', template: `${n.event}.${ch}.v1`, status: `Simulated — not sent (no ${ch.toUpperCase()} provider approved, DEC-14)`, created_at: now() });
      }
    }
  }
  return created;
}
