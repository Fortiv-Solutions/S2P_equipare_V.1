/** Lookup and date helpers shared by the base seed and module seeds. */
import { get } from '../core/db.ts';
import type { Actor } from '../core/auth.ts';
import { permsFor, type Role } from '../core/permissions.ts';

/** User id by e-mail local part, e.g. U('amit.kulkarni'). */
export function U(local: string): number {
  const r = get<{ id: number }>("SELECT id FROM users WHERE email LIKE ?", `${local}@%`);
  if (!r) throw new Error(`seed: user ${local} not found`);
  return r.id;
}
/** Vendor id by SAP code (or by name for vendors without a code). */
export function V(codeOrName: string): number {
  const r = get<{ id: number }>('SELECT id FROM vendors WHERE sap_code = ? OR name = ?', codeOrName, codeOrName);
  if (!r) throw new Error(`seed: vendor ${codeOrName} not found`);
  return r.id;
}
/** Material id by code. */
export function M(code: string): number {
  const r = get<{ id: number }>('SELECT id FROM materials WHERE code = ?', code);
  if (!r) throw new Error(`seed: material ${code} not found`);
  return r.id;
}
/** PR line id by "PRNO/ITEM". */
export function PRL(ref: string): number {
  const [pr, item] = ref.split('/');
  const r = get<{ id: number }>('SELECT id FROM pr_lines WHERE pr_no = ? AND item = ?', pr, Number(item));
  if (!r) throw new Error(`seed: PR line ${ref} not found`);
  return r.id;
}
/** PO id by number. */
export function PO(no: string): number {
  const r = get<{ id: number }>('SELECT id FROM pos WHERE po_no = ?', no);
  if (!r) throw new Error(`seed: PO ${no} not found`);
  return r.id;
}
/** Build an Actor for calling service functions as a seeded user. */
export function actorFor(local: string, role?: Role): Actor {
  const u = get<{ id: number; name: string; email: string; roles: string; vendor_id: number | null; plant_scope: string | null; categories: string | null; department: string | null }>(
    'SELECT * FROM users WHERE email LIKE ?', `${local}@%`,
  );
  if (!u) throw new Error(`seed: user ${local} not found`);
  const roles = u.roles.split(',') as Role[];
  const r = role ?? roles[0];
  return {
    id: u.id, name: u.name, email: u.email, roles, role: r, perms: permsFor(r), vendorId: r === 'VEN' ? u.vendor_id : null,
    plants: !u.plant_scope || u.plant_scope === '*' ? '*' : u.plant_scope.split(','), categories: u.categories ? u.categories.split(',') : [],
    department: u.department, sessionId: 'seed', channel: 'seed',
  };
}
/** ISO timestamp offset from now by days (negative = past). */
export const D = (days: number, hour = 10) => {
  const d = new Date(Date.now() + days * 86400000);
  d.setUTCHours(hour - 5, 30, 0, 0); // hour in IST
  return d.toISOString();
};
/** Date-only (YYYY-MM-DD) offset from today. */
export const DAY = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
