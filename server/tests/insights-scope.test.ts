/**
 * The ask box in multi-user mode: each question needs the permission of the module it reads, and plant-scoped
 * users only see their own plants. Separate file because the test harness binds one database per file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.ts';

describe('Ask box respects role and plant scope (multi-user mode)', () => {
  let m: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => { m = await startApp(); });
  afterAll(async () => { await m.close(); });

  it('answers only what the role may read, and says so otherwise', async () => {
    const sto = m.db.get<{ email: string }>("SELECT email FROM users WHERE roles = 'STO' AND active = 1 LIMIT 1")!;
    const c = await m.login(sto.email.split('@')[0]);
    for (const q of ['Which invoices are on hold and why?', 'Contracts expiring soon', 'Open advances', 'Which RFQs have low response?', 'What is waiting for my approval?']) {
      const r = await c.get('/api/insights/ask?q=' + encodeURIComponent(q));
      expect(r.status, q).toBe(200);
      expect(r.body.understood, q).toMatch(/not available to your role/);
      expect(r.body.total, q).toBe(0);
    }
    expect((await c.get('/api/insights/ask?q=' + encodeURIComponent('Which POs are late?'))).body.understood).toMatch(/past their committed delivery date/);
  });

  it('keeps plant-scoped users to their own plants', async () => {
    const u = m.db.get<{ email: string; plant_scope: string }>("SELECT email, plant_scope FROM users WHERE roles IN ('STO','BUY') AND plant_scope IS NOT NULL AND plant_scope != '*' AND active = 1 LIMIT 1");
    if (!u) return; // persona data dependent
    const plants = u.plant_scope.split(',');
    const c = await m.login(u.email.split('@')[0]);
    for (const q of ['Which POs are late?', 'POs not acknowledged', 'Which POs are likely to be late?', 'Open disputes']) {
      const r = (await c.get('/api/insights/ask?q=' + encodeURIComponent(q))).body;
      for (const row of r.rows ?? []) {
        const id = Number(String(row.link).split('/').pop());
        const table = String(row.link).startsWith('/disputes') ? 'SELECT p.plant FROM disputes d JOIN pos p ON p.id = d.po_id WHERE d.id = ?' : 'SELECT plant FROM pos WHERE id = ?';
        expect(plants, `${q} -> ${row.link}`).toContain(m.db.get<{ plant: string }>(table, id)!.plant);
      }
    }
  });
});
