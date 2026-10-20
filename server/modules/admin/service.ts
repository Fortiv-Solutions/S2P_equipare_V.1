/**
 * Platform administration (PRD Sec 6, 10.3 SCR-ADM-01..04): users & roles with segregation-of-duties
 * warnings, lock / unlock / deactivate / password reset, master mappings (buyer matrix, spend
 * categories, material-group map). Every action is audited (FR-PLT-01); administrators never
 * approve transactions.
 */
import crypto from 'node:crypto';
import { all, get, insert, update, run, now, scalar, tx } from '../../core/db.ts';
import { audit, diff } from '../../core/audit.ts';
import { cfg } from '../../core/config.ts';
import { badRequest, conflict, forbidden, notFound } from '../../core/http.ts';
import { hashPassword, revokeUserSessions, type Actor } from '../../core/auth.ts';
import { ROLES, isRole } from '../../core/permissions.ts';
import { SINGLE_USER } from '../../core/mode.ts';

const SIM_EMAIL = 'Simulated — not sent (no e-mail provider connected)';

export interface UserRecord {
  id: number; name: string; email: string; phone: string | null; roles: string; department: string | null; plant_scope: string | null;
  categories: string | null; title: string | null; vendor_id: number | null; vendor_role: string | null; active: number; locked: number;
  failed_attempts: number; manager_id: number | null; last_login: string | null; created_at: string | null;
}
const SAFE_COLS = 'u.id, u.name, u.email, u.phone, u.roles, u.department, u.plant_scope, u.categories, u.title, u.vendor_id, u.vendor_role, u.active, u.locked, u.failed_attempts, u.manager_id, u.last_login, u.created_at';

/** Random temporary password that meets the password rule (≥10 chars, letter and number). */
export function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const pick = (s: string) => s[crypto.randomInt(0, s.length)];
  let p = '';
  for (let i = 0; i < 8; i++) p += pick(alphabet);
  return `${p}-${crypto.randomInt(10, 99)}${pick('23456789')}`;
}

/** Role combinations that break segregation of duties (warned, not blocked — PRD Sec 6). */
export function sodWarnings(roles: string[]) {
  const rules = cfg<{ roles: string[]; risk: string }[]>('security.sod_conflicts');
  return rules.filter((r) => r.roles.every((x) => roles.includes(x))).map((r) => ({ roles: r.roles, risk: r.risk }));
}

const getUser = (id: number) => get<UserRecord>(`SELECT ${SAFE_COLS} FROM users u WHERE u.id = ?`, id);
function mustUser(id: number) {
  const u = getUser(id);
  if (!u) throw notFound('User');
  return u;
}

export function listUsers() {
  return all<UserRecord & { vendor_name: string | null; manager_name: string | null; sessions: number }>(
    `SELECT ${SAFE_COLS}, v.name AS vendor_name, v.sap_code AS vendor_sap_code, m.name AS manager_name,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
     FROM users u LEFT JOIN vendors v ON v.id = u.vendor_id LEFT JOIN users m ON m.id = u.manager_id ORDER BY u.vendor_id IS NOT NULL, u.name`, now(),
  ).map((u) => ({ ...u, role_list: u.roles.split(','), sod: sodWarnings(u.roles.split(',')) }));
}

export function userMeta() {
  return {
    roles: Object.entries(ROLES).filter(([k]) => k !== 'VEN').map(([code, label]) => ({ code, label })),
    plants: all('SELECT code, name FROM plants ORDER BY code'),
    categories: all('SELECT code, name FROM spend_categories ORDER BY name'),
    managers: all("SELECT id, name, title FROM users WHERE active = 1 AND vendor_id IS NULL ORDER BY name"),
    vendors: all("SELECT id, name, sap_code, onboarding_status FROM vendors ORDER BY name"),
    vendor_roles: cfg<string[]>('vendor.roles'),
    sod_rules: cfg('security.sod_conflicts'),
    max_failed_logins: cfg<number>('security.max_failed_logins'),
  };
}

export interface UserInput {
  name: string; email: string; phone?: string | null; title?: string | null; department?: string | null;
  roles?: string[]; plant_scope?: string[] | '*'; categories?: string[]; manager_id?: number | null;
  vendor_id?: number | null; vendor_role?: string | null;
}

function normaliseInternal(b: UserInput) {
  const roles = [...new Set(b.roles ?? [])];
  if (!roles.length) throw badRequest('Choose at least one role.', { roles: 'Choose a role' });
  for (const r of roles) if (!isRole(r) || r === 'VEN') throw badRequest(`${r} is not an internal role. Vendor users are created from the vendor record.`, { roles: 'Invalid role' });
  const plants = b.plant_scope === '*' || !b.plant_scope?.length ? '*' : b.plant_scope;
  if (plants !== '*') {
    const known = new Set(all<{ code: string }>('SELECT code FROM plants').map((p) => p.code));
    for (const p of plants) if (!known.has(p)) throw badRequest(`Unknown plant ${p}.`, { plant_scope: 'Unknown plant' });
  }
  const cats = b.categories ?? [];
  if (cats.length) {
    const known = new Set(all<{ code: string }>('SELECT code FROM spend_categories').map((c) => c.code));
    for (const c of cats) if (!known.has(c)) throw badRequest(`Unknown category ${c}.`, { categories: 'Unknown category' });
  }
  if (cats.length && !roles.includes('BUY')) throw badRequest('Buyer categories apply only to users with the Procurement Buyer role.', { categories: 'Only for buyers' });
  return { roles: roles.join(','), plant_scope: plants === '*' ? '*' : plants.join(','), categories: cats.length ? cats.join(',') : null };
}

/** Create an internal or vendor user. Returns the temporary password once (simulated e-mail). */
export function createUser(actor: Actor, b: UserInput, opts: { vendorSelf?: boolean } = {}) {
  if (SINGLE_USER) throw conflict('This installation runs in single-user mode with one Administrator account, so no other accounts can be created. Vendors are served through the vendor portal view instead.');
  const email = b.email.trim().toLowerCase();
  if (get('SELECT id FROM users WHERE lower(email) = ?', email)) throw conflict('A user with this e-mail already exists. Search the list and edit that user instead.');
  let fields: Record<string, unknown>;
  if (b.vendor_id) {
    const v = get<{ id: number; name: string; onboarding_status: string }>('SELECT id, name, onboarding_status FROM vendors WHERE id = ?', b.vendor_id);
    if (!v) throw badRequest('Choose a vendor.', { vendor_id: 'Unknown vendor' });
    const vr = b.vendor_role ?? '';
    if (!cfg<string[]>('vendor.roles').includes(vr)) throw badRequest('Choose a vendor role (administrator, sales, dispatch or accounts).', { vendor_role: 'Choose a role' });
    fields = { roles: 'VEN', vendor_id: v.id, vendor_role: vr, plant_scope: '*', categories: null, department: null, manager_id: null };
  } else {
    if (opts.vendorSelf) throw forbidden();
    const n = normaliseInternal(b);
    if (b.manager_id && !get('SELECT id FROM users WHERE id = ? AND vendor_id IS NULL', b.manager_id)) throw badRequest('Choose a manager from the list.', { manager_id: 'Unknown user' });
    fields = { ...n, vendor_id: null, vendor_role: null, department: b.department?.trim() || null, manager_id: b.manager_id ?? null };
  }
  const pw = tempPassword();
  const id = tx(() => {
    const uid = insert('users', {
      name: b.name.trim(), email, phone: b.phone?.trim() || null, title: b.title?.trim() || null, ...fields,
      password_hash: hashPassword(pw), active: 1, locked: 0, failed_attempts: 0, created_at: now(),
    });
    insert('outbox', {
      channel: 'email', recipient: email, subject: 'Your Equipcare S2P account', template: 'USER-CREATED.v1', status: SIM_EMAIL, created_at: now(),
      body: `Dear ${b.name.trim()}, an account was created for you by ${actor.name}. Sign in at /login with this e-mail and the temporary password given to you (not stored in this record), then change it under Profile.`,
    });
    const { password_hash: _p, ...safe } = { ...fields, name: b.name.trim(), email, password_hash: '' };
    audit(actor, { action: b.vendor_id ? 'user.vendor_user_created' : 'user.created', objectType: 'user', objectId: uid, objectRef: email, after: safe });
    return uid;
  });
  if (b.vendor_id) run("UPDATE vendors SET portal_status = 'Active' WHERE id = ? AND onboarding_status = 'Active' AND portal_status IN ('Not invited','Invited','Locked','Deactivated')", b.vendor_id);
  const roles = String(fields.roles).split(',');
  return { id, temporary_password: pw, sod_warnings: sodWarnings(roles), delivery: 'Shown once. The welcome e-mail is in the simulated outbox and was not sent.' };
}

export function updateUser(actor: Actor, id: number, b: Partial<UserInput> & { reason?: string | null }) {
  const u = mustUser(id);
  const next: Record<string, unknown> = {};
  if (b.name !== undefined) next.name = b.name.trim();
  if (b.phone !== undefined) next.phone = b.phone?.trim() || null;
  if (b.title !== undefined) next.title = b.title?.trim() || null;
  if (b.email !== undefined) {
    const email = b.email.trim().toLowerCase();
    if (email !== u.email && get('SELECT id FROM users WHERE lower(email) = ? AND id != ?', email, id)) throw conflict('Another user already has this e-mail.');
    next.email = email;
  }
  if (u.vendor_id) {
    if (b.vendor_role !== undefined) {
      if (!cfg<string[]>('vendor.roles').includes(b.vendor_role ?? '')) throw badRequest('Choose a vendor role.', { vendor_role: 'Choose a role' });
      next.vendor_role = b.vendor_role;
    }
  } else {
    if (b.roles !== undefined || b.plant_scope !== undefined || b.categories !== undefined) {
      const n = normaliseInternal({
        name: u.name, email: u.email, roles: b.roles ?? u.roles.split(','),
        plant_scope: b.plant_scope ?? (u.plant_scope === '*' || !u.plant_scope ? '*' : u.plant_scope.split(',')),
        categories: b.categories ?? (u.categories ? u.categories.split(',') : []),
      });
      if (id === actor.id && !n.roles.split(',').includes('ADM')) throw conflict('You cannot remove your own administrator role. Ask another administrator.');
      Object.assign(next, n);
    }
    if (b.department !== undefined) next.department = b.department?.trim() || null;
    if (b.manager_id !== undefined) {
      if (b.manager_id === id) throw badRequest('A user cannot be their own manager.', { manager_id: 'Choose someone else' });
      if (b.manager_id && !get('SELECT id FROM users WHERE id = ? AND vendor_id IS NULL', b.manager_id)) throw badRequest('Choose a manager from the list.', { manager_id: 'Unknown user' });
      next.manager_id = b.manager_id ?? null;
    }
  }
  const d = diff(u as unknown as Record<string, unknown>, next);
  if (!Object.keys(d.after).length) throw badRequest('Nothing changed.');
  if ('roles' in d.after && (!b.reason || b.reason.trim().length < 10)) throw badRequest('Changing roles needs a reason of at least 10 characters (recorded in the audit trail).', { reason: 'Reason is required' });
  update('users', id, next);
  audit(actor, { action: 'roles' in d.after ? 'user.roles_changed' : 'user.updated', objectType: 'user', objectId: id, objectRef: u.email, ...d, reason: b.reason ?? null });
  return { ok: true, sod_warnings: sodWarnings(String(next.roles ?? u.roles).split(',')) };
}

function guardSelf(actor: Actor, id: number, what: string) {
  if (actor.id === id) throw conflict(`You cannot ${what} your own account.`);
}

export function lockUser(actor: Actor, id: number, reason: string) {
  const u = mustUser(id);
  guardSelf(actor, id, 'lock');
  if (u.locked) throw conflict('The account is already locked.');
  update('users', id, { locked: 1 });
  revokeUserSessions(id);
  audit(actor, { action: 'user.locked', objectType: 'user', objectId: id, objectRef: u.email, before: { locked: 0 }, after: { locked: 1, sessions_revoked: true }, reason });
  return { ok: true };
}

/** Admin unlock resets failed attempts (AC-VPT-01). */
export function unlockUser(actor: Actor, id: number, reason: string | null) {
  const u = mustUser(id);
  if (!u.locked && !u.failed_attempts) throw conflict('The account is not locked.');
  update('users', id, { locked: 0, failed_attempts: 0 });
  audit(actor, { action: 'user.unlocked', objectType: 'user', objectId: id, objectRef: u.email, before: { locked: u.locked, failed_attempts: u.failed_attempts }, after: { locked: 0, failed_attempts: 0 }, reason });
  return { ok: true };
}

export function deactivateUser(actor: Actor, id: number, reason: string) {
  const u = mustUser(id);
  guardSelf(actor, id, 'deactivate');
  if (!u.active) throw conflict('The account is already deactivated.');
  update('users', id, { active: 0 });
  revokeUserSessions(id);
  audit(actor, { action: 'user.deactivated', objectType: 'user', objectId: id, objectRef: u.email, before: { active: 1 }, after: { active: 0, sessions_revoked: true }, reason });
  return { ok: true };
}

export function reactivateUser(actor: Actor, id: number, reason: string) {
  const u = mustUser(id);
  if (u.active) throw conflict('The account is already active.');
  update('users', id, { active: 1, failed_attempts: 0 });
  audit(actor, { action: 'user.reactivated', objectType: 'user', objectId: id, objectRef: u.email, before: { active: 0 }, after: { active: 1 }, reason });
  return { ok: true };
}

export function resetPassword(actor: Actor, id: number) {
  const u = mustUser(id);
  guardSelf(actor, id, 'reset the password of');
  const pw = tempPassword();
  update('users', id, { password_hash: hashPassword(pw), failed_attempts: 0 });
  revokeUserSessions(id);
  insert('outbox', {
    channel: 'email', recipient: u.email, subject: 'Your Equipcare S2P password was reset', template: 'PASSWORD-RESET.v1', status: SIM_EMAIL, created_at: now(),
    body: `Dear ${u.name}, ${actor.name} reset your password. Use the temporary password given to you (not stored in this record) and change it under Profile.`,
  });
  audit(actor, { action: 'user.password_reset', objectType: 'user', objectId: id, objectRef: u.email, after: { sessions_revoked: true, failed_attempts: 0 } });
  return { temporary_password: pw, delivery: 'Shown once. The e-mail notice is in the simulated outbox and was not sent.' };
}

// ------------------------------------------------------------------ masters (SCR-ADM-03)
export function buyerMatrix() {
  return all(
    `SELECT m.*, b.name AS buyer_name, bb.name AS backup_name, c.name AS category_name FROM buyer_matrix m
     LEFT JOIN users b ON b.id = m.buyer_id LEFT JOIN users bb ON bb.id = m.backup_buyer_id LEFT JOIN spend_categories c ON c.code = m.category
     ORDER BY m.category, m.plant, m.priority_route`,
  );
}

export interface MatrixInput { category: string; plant: string; priority_route: string; buyer_id: number; backup_buyer_id?: number | null; active: boolean }
function checkMatrix(b: MatrixInput, selfId = 0) {
  if (!get('SELECT code FROM spend_categories WHERE code = ?', b.category)) throw badRequest('Choose a spend category.', { category: 'Unknown category' });
  if (b.plant !== '*' && !get('SELECT code FROM plants WHERE code = ?', b.plant)) throw badRequest('Choose a plant or All plants.', { plant: 'Unknown plant' });
  if (!['*', 'Normal', 'Urgent', 'BD', 'Class 1'].includes(b.priority_route)) throw badRequest('Choose a priority or Any.', { priority_route: 'Unknown priority' });
  const isBuyer = (id: number) => !!get("SELECT id FROM users WHERE id = ? AND active = 1 AND (',' || roles || ',') LIKE '%,BUY,%'", id);
  if (!isBuyer(b.buyer_id)) throw badRequest('The buyer must be an active user with the Procurement Buyer role.', { buyer_id: 'Not a buyer' });
  if (b.backup_buyer_id && !isBuyer(b.backup_buyer_id)) throw badRequest('The backup must be an active buyer.', { backup_buyer_id: 'Not a buyer' });
  if (b.backup_buyer_id === b.buyer_id) throw badRequest('Backup buyer must be a different person.', { backup_buyer_id: 'Same as buyer' });
  if (b.active && get('SELECT id FROM buyer_matrix WHERE category = ? AND plant = ? AND priority_route = ? AND active = 1 AND id != ?', b.category, b.plant, b.priority_route, selfId)) {
    throw conflict('An active row already covers this category, plant and priority. Edit that row instead.');
  }
}
export function createMatrixRow(actor: Actor, b: MatrixInput) {
  checkMatrix(b);
  const id = insert('buyer_matrix', { ...b, backup_buyer_id: b.backup_buyer_id ?? null, active: b.active ? 1 : 0 });
  audit(actor, { action: 'master.buyer_matrix_created', objectType: 'buyer_matrix', objectId: id, objectRef: `${b.category}/${b.plant}`, after: b });
  return { id };
}
export function updateMatrixRow(actor: Actor, id: number, b: MatrixInput) {
  const row = get<Record<string, unknown>>('SELECT * FROM buyer_matrix WHERE id = ?', id);
  if (!row) throw notFound('Matrix row');
  checkMatrix(b, id);
  const next = { ...b, backup_buyer_id: b.backup_buyer_id ?? null, active: b.active ? 1 : 0 };
  update('buyer_matrix', id, next);
  audit(actor, { action: 'master.buyer_matrix_updated', objectType: 'buyer_matrix', objectId: id, objectRef: `${b.category}/${b.plant}`, ...diff(row, next) });
  return { ok: true };
}
export function deleteMatrixRow(actor: Actor, id: number, reason: string) {
  const row = get<Record<string, unknown>>('SELECT * FROM buyer_matrix WHERE id = ?', id);
  if (!row) throw notFound('Matrix row');
  run('DELETE FROM buyer_matrix WHERE id = ?', id);
  audit(actor, { action: 'master.buyer_matrix_deleted', objectType: 'buyer_matrix', objectId: id, objectRef: `${row.category}/${row.plant}`, before: row, reason });
  return { ok: true };
}

export function categories() {
  return all(
    `SELECT c.*, (SELECT COUNT(*) FROM materials m WHERE m.category = c.code) AS materials,
       (SELECT COUNT(*) FROM vendor_capabilities v WHERE v.category = c.code AND v.status = 'Approved') AS vendors,
       (SELECT COUNT(*) FROM material_group_map g WHERE g.category = c.code) AS groups,
       (SELECT COUNT(*) FROM buyer_matrix b WHERE b.category = c.code AND b.active = 1) AS matrix_rows
     FROM spend_categories c ORDER BY c.code`,
  );
}
export interface CategoryInput { code: string; name: string; parent?: string | null; min_vendors: number; rfq_rule?: string | null; itc_recoverable: boolean; description?: string | null }
export function saveCategory(actor: Actor, b: CategoryInput, isNew: boolean) {
  const code = b.code.trim().toUpperCase();
  const row = get<Record<string, unknown>>('SELECT * FROM spend_categories WHERE code = ?', code);
  if (isNew && row) throw conflict(`Category ${code} already exists.`);
  if (!isNew && !row) throw notFound('Category');
  if (b.parent && (b.parent === code || !get('SELECT code FROM spend_categories WHERE code = ?', b.parent))) throw badRequest('Choose an existing parent category.', { parent: 'Unknown parent' });
  const vals = { name: b.name.trim(), parent: b.parent || null, min_vendors: b.min_vendors, rfq_rule: b.rfq_rule?.trim() || null, itc_recoverable: b.itc_recoverable ? 1 : 0, description: b.description?.trim() || null };
  if (isNew) insert('spend_categories', { code, ...vals });
  else run('UPDATE spend_categories SET name = ?, parent = ?, min_vendors = ?, rfq_rule = ?, itc_recoverable = ?, description = ? WHERE code = ?', vals.name, vals.parent, vals.min_vendors, vals.rfq_rule, vals.itc_recoverable, vals.description, code);
  audit(actor, { action: isNew ? 'master.category_created' : 'master.category_updated', objectType: 'spend_category', objectId: code, objectRef: code, ...(isNew ? { after: vals } : diff(row!, vals)) });
  return { code };
}
export function deleteCategory(actor: Actor, code: string, reason: string) {
  const row = get<Record<string, unknown>>('SELECT * FROM spend_categories WHERE code = ?', code);
  if (!row) throw notFound('Category');
  const uses = (scalar<number>('SELECT COUNT(*) FROM materials WHERE category = ?', code) ?? 0) + (scalar<number>('SELECT COUNT(*) FROM material_group_map WHERE category = ?', code) ?? 0)
    + (scalar<number>('SELECT COUNT(*) FROM buyer_matrix WHERE category = ?', code) ?? 0) + (scalar<number>('SELECT COUNT(*) FROM vendor_capabilities WHERE category = ?', code) ?? 0);
  if (uses) throw conflict(`Category ${code} is used by materials, mappings, buyers or vendor capabilities (${uses} records). Remap them first.`);
  run('DELETE FROM spend_categories WHERE code = ?', code);
  audit(actor, { action: 'master.category_deleted', objectType: 'spend_category', objectId: code, before: row, reason });
  return { ok: true };
}

export function materialGroups() {
  return all(
    `SELECT g.material_group, g.category, c.name AS category_name, (SELECT COUNT(*) FROM materials m WHERE m.material_group = g.material_group) AS materials,
       (SELECT COUNT(*) FROM materials m WHERE m.material_group = g.material_group AND COALESCE(m.category,'') != g.category) AS mismatched
     FROM material_group_map g LEFT JOIN spend_categories c ON c.code = g.category ORDER BY g.material_group`,
  );
}
export function saveMaterialGroup(actor: Actor, b: { material_group: string; category: string; apply_to_materials?: boolean }, isNew: boolean) {
  const g = b.material_group.trim().toUpperCase();
  if (!get('SELECT code FROM spend_categories WHERE code = ?', b.category)) throw badRequest('Choose a spend category.', { category: 'Unknown category' });
  const row = get<{ category: string }>('SELECT category FROM material_group_map WHERE material_group = ?', g);
  if (isNew && row) throw conflict(`Material group ${g} is already mapped to ${row.category}.`);
  if (!isNew && !row) throw notFound('Material group');
  if (isNew) insert('material_group_map', { material_group: g, category: b.category });
  else run('UPDATE material_group_map SET category = ? WHERE material_group = ?', b.category, g);
  let updated = 0;
  // Spend category on a material is a platform mapping (not an SAP field), so it may be re-applied.
  if (b.apply_to_materials) updated = run('UPDATE materials SET category = ? WHERE material_group = ?', b.category, g).changes;
  audit(actor, { action: isNew ? 'master.material_group_created' : 'master.material_group_updated', objectType: 'material_group', objectId: g, objectRef: g, before: row ? { category: row.category } : undefined, after: { category: b.category, materials_updated: updated } });
  return { material_group: g, materials_updated: updated };
}
export function deleteMaterialGroup(actor: Actor, g: string, reason: string) {
  const row = get<{ category: string }>('SELECT category FROM material_group_map WHERE material_group = ?', g);
  if (!row) throw notFound('Material group');
  run('DELETE FROM material_group_map WHERE material_group = ?', g);
  audit(actor, { action: 'master.material_group_deleted', objectType: 'material_group', objectId: g, before: row, reason });
  return { ok: true };
}

export function adminSummary() {
  const n = (sql: string, ...p: unknown[]) => scalar<number>(sql, ...p) ?? 0;
  return {
    users: n('SELECT COUNT(*) FROM users WHERE active = 1 AND vendor_id IS NULL'),
    vendor_users: n('SELECT COUNT(*) FROM users WHERE active = 1 AND vendor_id IS NOT NULL'),
    locked: n('SELECT COUNT(*) FROM users WHERE locked = 1'),
    inactive: n('SELECT COUNT(*) FROM users WHERE active = 0'),
    sod: listUsers().filter((u) => u.active && u.sod.length).length,
    config: n('SELECT COUNT(*) FROM config'),
    config_pending: n("SELECT COUNT(*) FROM config_history WHERE status = 'Pending'"),
    decisions_open: n('SELECT COUNT(*) FROM config WHERE decision_ref IS NOT NULL'),
    matrix_rows: n('SELECT COUNT(*) FROM buyer_matrix WHERE active = 1'),
    categories: n('SELECT COUNT(*) FROM spend_categories'),
    groups: n('SELECT COUNT(*) FROM material_group_map'),
    approval_matrix: n('SELECT COUNT(*) FROM approval_matrix WHERE active = 1'),
    jobs_failed_24h: n("SELECT COUNT(*) FROM job_runs WHERE status = 'Failed' AND started_at > ?", new Date(Date.now() - 86400000).toISOString()),
    job_runs_24h: n('SELECT COUNT(*) FROM job_runs WHERE started_at > ?', new Date(Date.now() - 86400000).toISOString()),
    outbox: n('SELECT COUNT(*) FROM outbox'),
    audit_24h: n('SELECT COUNT(*) FROM audit_events WHERE ts > ?', new Date(Date.now() - 86400000).toISOString()),
  };
}

export function pendingConfig() {
  return all(
    `SELECT h.id, h.key, h.value_json, h.reason, h.requested_at, u.name AS requested_by_name, c.label, c.value_json AS current_json,
            a.id AS approval_id, a.req_no, a.status AS approval_status
     FROM config_history h JOIN config c ON c.key = h.key LEFT JOIN users u ON u.id = h.requested_by
     LEFT JOIN approvals a ON a.object_type = 'config_change' AND a.object_id = h.id
     WHERE h.status = 'Pending' ORDER BY h.id DESC`,
  );
}
