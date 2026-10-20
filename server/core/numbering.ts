import { get, run } from './db.ts';

/** Sequential document numbers, e.g. nextNo('RFQ') -> "RFQ-26-00012". */
export function nextNo(prefix: string, width = 5) {
  const yy = String(new Date().getUTCFullYear() % 100).padStart(2, '0');
  const name = `${prefix}-${yy}`;
  const row = get<{ value: number }>('SELECT value FROM sequences WHERE name = ?', name);
  const value = (row?.value ?? 0) + 1;
  if (row) run('UPDATE sequences SET value = ? WHERE name = ?', value, name);
  else run('INSERT INTO sequences (name, value) VALUES (?, ?)', name, value);
  return `${name}-${String(value).padStart(width, '0')}`;
}

/** Plain numeric SAP-style sequence (simulator only), e.g. nextSapNo('PO', 4500010000). */
export function nextSapNo(name: string, start: number) {
  const key = `SAP-${name}`;
  const row = get<{ value: number }>('SELECT value FROM sequences WHERE name = ?', key);
  const value = row ? row.value + 1 : start;
  if (row) run('UPDATE sequences SET value = ? WHERE name = ?', value, key);
  else run('INSERT INTO sequences (name, value) VALUES (?, ?)', key, value);
  return String(value);
}
