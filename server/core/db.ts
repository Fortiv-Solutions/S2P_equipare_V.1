/**
 * Persistence layer on Node's built-in SQLite (node:sqlite).
 *
 * Conventions every module follows:
 *  - Columns ending in `_json` hold JSON text. Rows returned by `all`/`get` expose them
 *    parsed, under the name without the suffix (e.g. `checks_json` -> `checks`).
 *  - Write JSON with `J(value)`.
 *  - Booleans are stored as 0/1 integers.
 *  - Timestamps are ISO-8601 UTC strings (`now()`); the UI renders them in IST.
 *  - Money is stored in rupees (REAL) with a `currency` column where relevant (default INR).
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.S2P_DATA_DIR ?? path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_FILE = process.env.S2P_DB ?? path.join(DATA_DIR, 's2p.db');
export const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const cache = new Map<string, StatementSync>();
function stmt(sql: string): StatementSync {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export type Param = string | number | bigint | null | Uint8Array;
type Row = Record<string, unknown>;

function mapRow<T>(row: Row | undefined): T | undefined {
  if (!row) return undefined;
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_json')) {
      const key = k.slice(0, -5);
      if (typeof v === 'string' && v.length) {
        try {
          out[key] = JSON.parse(v);
        } catch {
          out[key] = null;
        }
      } else out[key] = null;
    } else out[k] = v;
  }
  return out as T;
}

function norm(params: unknown[]): Param[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p as Param;
  });
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return (stmt(sql).all(...norm(params)) as Row[]).map((r) => mapRow<T>(r)!) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return mapRow<T>(stmt(sql).get(...norm(params)) as Row | undefined);
}

export function run(sql: string, ...params: unknown[]) {
  const r = stmt(sql).run(...norm(params));
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}

/** Scalar helper: first column of first row. */
export function scalar<T = number>(sql: string, ...params: unknown[]): T | undefined {
  const row = stmt(sql).get(...norm(params)) as Row | undefined;
  if (!row) return undefined;
  return Object.values(row)[0] as T;
}

/** Insert an object into a table; keys become column names. Returns new row id. */
export function insert(table: string, values: Record<string, unknown>): number {
  const keys = Object.keys(values).filter((k) => values[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return run(sql, ...keys.map((k) => values[k])).lastId;
}

/** Update columns of one row by id. */
export function update(table: string, id: number | string, values: Record<string, unknown>, idCol = 'id') {
  const keys = Object.keys(values).filter((k) => values[k] !== undefined);
  if (!keys.length) return { changes: 0, lastId: 0 };
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`;
  return run(sql, ...keys.map((k) => values[k]), id);
}

let depth = 0;
/** Run fn in a transaction (nested calls use savepoints). */
export function tx<T>(fn: () => T): T {
  const sp = `sp${depth}`;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${sp}`);
  depth++;
  try {
    const result = fn();
    depth--;
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${sp}`);
    return result;
  } catch (e) {
    depth--;
    if (depth === 0) db.exec('ROLLBACK');
    else db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

export const J = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
export const now = () => new Date().toISOString();
export const addDays = (d: Date | string, days: number) => {
  const x = new Date(d);
  x.setTime(x.getTime() + days * 86400000);
  return x.toISOString();
};
export const addHours = (d: Date | string, h: number) => new Date(new Date(d).getTime() + h * 3600000).toISOString();
export const daysBetween = (a: string | Date, b: string | Date = new Date()) =>
  Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Indian financial year label for a date, e.g. 2026-10-16 -> "2026-27". */
export function financialYear(d: string | Date) {
  const x = new Date(d);
  const y = x.getUTCMonth() >= 3 ? x.getUTCFullYear() : x.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}
