/** `npm run seed` — delete the database and recreate demo data. */
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.S2P_DATA_DIR ?? path.resolve(process.cwd(), 'data');
for (const f of ['s2p.db', 's2p.db-wal', 's2p.db-shm']) fs.rmSync(path.join(dataDir, f), { force: true });
fs.rmSync(path.join(dataDir, 'files'), { recursive: true, force: true });

const { migrate } = await import('../core/schema.ts');
const { MODULES } = await import('../modules/index.ts');
const { ensureSeeded } = await import('./seed.ts');
migrate();
for (const m of MODULES) m.init?.();
ensureSeeded();
console.log('Demo data reset.');
