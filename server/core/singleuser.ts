/**
 * Single-user consolidation: merges every account into one Administrator.
 *
 * What it does (idempotent; runs after seeding and on start-up for older databases):
 *  - keeps one account (the existing administrator, id preserved) and gives it every internal role;
 *  - reassigns everything the other accounts owned or authored to the Administrator, in every table, by
 *    inspecting the schema (so tables added by modules are covered too);
 *  - tags vendor-authored messages with the vendor name and records which vendor each vendor-facing
 *    notification belonged to, so conversations stay readable once the vendor accounts are gone;
 *  - deletes the other accounts and their sessions.
 *
 * What it deliberately does NOT touch:
 *  - `audit_events` — the hash-chained history keeps the original actor ids and names;
 *  - `approvals.requester_id` and `invoices.uploaded_by` — segregation of duties compares these with the
 *    acting user, so historic requests keep their original author instead of silently becoming self-raised.
 */
import { db, all, get, run, now } from './db.ts';
import { audit } from './audit.ts';
import { ADMIN_EMAIL, ADMIN_NAME, SINGLE_USER } from './mode.ts';
import { MERGED_ROLES } from './permissions.ts';

/** Columns that hold a user id. `owner_id` is polymorphic elsewhere, so contracts.owner_id is listed explicitly. */
const USER_COLUMN = /^(user_id|buyer_id|backup_buyer_id|requisitioner_id|approver_id|assignee_id|owner_user_id|buyer_owner_id|delegated_from|invited_by|[a-z_]+_by)$/;
const EXPLICIT = new Set(['contracts.owner_id']);
const KEEP_AUTHOR = new Set(['approvals.requester_id', 'invoices.uploaded_by']);
const SKIP_TABLES = new Set(['users', 'sessions', 'audit_events']);

function hasColumn(table: string, column: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/**
 * The Administrator's user id. Before the merge has run (during seeding) the account that will become the
 * Administrator is the lowest-id user holding the ADM role — the merge keeps that id.
 */
export function adminId(): number {
  const u = get<{ id: number }>('SELECT id FROM users WHERE email = ?', ADMIN_EMAIL)
    ?? get<{ id: number }>("SELECT id FROM users WHERE (',' || roles || ',') LIKE '%,ADM,%' ORDER BY id LIMIT 1");
  if (!u) throw new Error('administrator account missing');
  return u.id;
}

/** Whether any account other than the Administrator still exists. */
export function needsMerge() {
  const total = get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
  if (!total) return false;
  const others = get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE email != ?', ADMIN_EMAIL)?.n ?? 0;
  const admin = get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE email = ?', ADMIN_EMAIL)?.n ?? 0;
  return others > 0 || admin === 0;
}

export function mergeIntoAdmin() {
  if (!needsMerge()) return { merged: false as const };
  // The account that becomes the Administrator: the existing one, else the lowest-id administrator.
  let admin = get<{ id: number }>('SELECT id FROM users WHERE email = ?', ADMIN_EMAIL)
    ?? get<{ id: number }>("SELECT id FROM users WHERE (',' || roles || ',') LIKE '%,ADM,%' ORDER BY id LIMIT 1")
    ?? get<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1');
  if (!admin) return { merged: false as const };
  const adminUserId = admin.id;
  const others = all<{ id: number; name: string; email: string; vendor_id: number | null }>('SELECT id, name, email, vendor_id FROM users WHERE id != ?', adminUserId);

  // 1. Keep vendor conversations readable and vendor notifications separate.
  const vendorAuthored: [string, string, string][] = [['ticket_messages', 'user_id', 'body'], ['comments', 'user_id', 'body'], ['dispute_events', 'user_id', 'body'], ['po_followups', 'user_id', 'note']];
  for (const [t, uc, bc] of vendorAuthored) {
    if (!hasColumn(t, uc) || !hasColumn(t, bc)) continue;
    run(`UPDATE ${t} SET ${bc} = '[' || (SELECT v.name FROM users u JOIN vendors v ON v.id = u.vendor_id WHERE u.id = ${t}.${uc}) || '] ' || COALESCE(${bc}, '')
         WHERE ${uc} IN (SELECT id FROM users WHERE vendor_id IS NOT NULL)`);
  }
  if (hasColumn('notifications', 'vendor_id')) {
    run('UPDATE notifications SET vendor_id = (SELECT vendor_id FROM users WHERE users.id = notifications.user_id) WHERE user_id IN (SELECT id FROM users WHERE vendor_id IS NOT NULL)');
  }

  // 2. Reassign ownership and authorship in every table.
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name).filter((t) => !SKIP_TABLES.has(t));
  const remapped: Record<string, number> = {};
  for (const t of tables) {
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string }[]).filter(
      (c) => /INT/i.test(c.type) && (USER_COLUMN.test(c.name) || EXPLICIT.has(`${t}.${c.name}`)) && !KEEP_AUTHOR.has(`${t}.${c.name}`),
    );
    for (const c of cols) {
      const r = run(`UPDATE ${t} SET ${c.name} = ? WHERE ${c.name} IN (SELECT id FROM users WHERE id != ?)`, adminUserId, adminUserId);
      if (r.changes) remapped[`${t}.${c.name}`] = r.changes;
    }
  }
  // Ids embedded in approval context JSON (who recommended / verified) follow the same rule as the columns above,
  // except `recommended_by`, which segregation of duties compares with the acting user.
  if (hasColumn('approvals', 'context_json')) {
    run("UPDATE approvals SET context_json = json_set(context_json, '$.verified_by', ?) WHERE json_extract(context_json, '$.verified_by') IS NOT NULL", adminUserId);
  }

  // 3. Remove the other accounts; the Administrator becomes the single account holding every internal role.
  run('DELETE FROM sessions');
  run('DELETE FROM users WHERE id != ?', adminUserId);
  const cats = all<{ code: string }>('SELECT code FROM spend_categories ORDER BY code').map((c) => c.code).join(',');
  run(
    `UPDATE users SET name = ?, email = ?, roles = ?, title = ?, department = ?, plant_scope = '*', categories = ?, vendor_id = NULL, vendor_role = NULL,
       manager_id = NULL, delegate_id = NULL, delegate_until = NULL, active = 1, locked = 0, failed_attempts = 0 WHERE id = ?`,
    ADMIN_NAME, ADMIN_EMAIL, MERGED_ROLES.join(','), 'Administrator — all modules', 'Procurement, Finance, Stores, IT', cats, adminUserId,
  );
  audit(null, { action: 'system.single_user_merge', objectType: 'system', objectId: 'users', after: { kept_user_id: adminUserId, removed_accounts: others.length, removed: others.map((o) => o.name), reassigned: remapped, at: now() }, reason: 'Single-user mode: all accounts merged into the Administrator' });
  return { merged: true as const, removed: others.length, reassigned: remapped };
}

/** Start-up hook: bring an older multi-user database into single-user shape. */
export function ensureSingleUser() {
  if (!SINGLE_USER) return;
  if (needsMerge()) {
    const r = mergeIntoAdmin();
    if (r.merged) console.log(`Single-user mode: merged ${r.removed} account(s) into the Administrator.`);
  }
}
