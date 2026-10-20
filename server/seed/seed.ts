import { now, run, scalar, tx } from '../core/db.ts';
import { seedBase } from './base.ts';
import { MODULES } from '../modules/index.ts';
import { SINGLE_USER, DEMO_EXTRA } from '../core/mode.ts';
import { seedBaseExtra } from './base_extra.ts';
import { mergeIntoAdmin } from '../core/singleuser.ts';

/** Seed demo data on an empty database. Module `init()` must have run first (sync hooks). */
export function ensureSeeded() {
  const users = scalar<number>('SELECT COUNT(*) FROM users') ?? 0;
  if (users > 0) return false;
  const t = Date.now();
  tx(() => {
    seedBase();
    if (DEMO_EXTRA) seedBaseExtra();
    for (const m of MODULES) m.seed?.();
    // Single-user mode: the demo history was built by distinct people; fold them into the one Administrator.
    // Tell the scheduler this is a fresh database, so its first pass does not flood the inbox (see core/scheduler.ts).
    run("INSERT OR REPLACE INTO sap_sim_settings (key, value_json) VALUES ('fresh_seed', '1')");
    if (SINGLE_USER) {
      mergeIntoAdmin();
      // A fresh install should not open with hundreds of unread items: keep the newest of each inbox unread.
      run(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND vendor_id IS NULL
           AND id NOT IN (SELECT id FROM notifications WHERE vendor_id IS NULL ORDER BY id DESC LIMIT 18)`, now());
      run(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND vendor_id IS NOT NULL
           AND id NOT IN (SELECT n.id FROM notifications n WHERE n.vendor_id = notifications.vendor_id ORDER BY n.id DESC LIMIT 6)`, now());
    }
  });
  console.log(`Seeded demo data in ${Date.now() - t} ms`);
  return true;
}
